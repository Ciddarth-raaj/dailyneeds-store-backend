const crypto = require("crypto");
const { toDateOnly } = require("../utils/shiftResolution");
const { istToday } = require("../utils/istDate");
const { payrollLockedActionError } = require("../utils/attendance_payroll_lock");
const { ADMIN_USER_TYPE } = require("../middlewares/admin_only");
const { REASON_CODES } = require("../constants/attendance_device_time_correction");

/**
 * DEVICE TIME CORRECTION - an administrator's bulk correction of punches a
 * terminal stamped while its clock was wrong.
 *
 * PREVIEW  reads the punches the criteria select and shows what each would
 *          become. It writes NOTHING, and issues the batch ID and the
 *          fingerprint of the punch set it showed.
 * APPLY    re-reads the same criteria, requires the same fingerprint (else the
 *          preview is stale), refuses a locked payroll month, calculates every
 *          affected employee's attendance day with the corrected times, and
 *          stores the correction and those days in ONE transaction.
 * REVERT   deactivates a batch's punch rows (they stay, with both times),
 *          marks the batch REVERTED with who / when / why, and stores the
 *          days recalculated on the original times - again in one
 *          transaction, again refused in a locked month.
 *
 * THE RAW PUNCH IS NEVER CHANGED. The corrected time lives in
 * `attendance_device_time_correction_punch`; every attendance read uses it
 * while the correction is active (`repository/lib/effective_punch_time.js`).
 *
 * THE CRITERIA, ALL OF WHICH MUST MATCH: the calendar date the device stamped,
 * the registered device (hence its exact Cloud ID), the device-clock window
 * (inclusive, to the second) and - when given - the outlet the device was
 * assigned to at the punch's device time. Nothing else is selectable, and no
 * punch id is accepted from the client.
 *
 * REFUSED OUTRIGHT (the whole batch, never a partial apply):
 *   - no punch matches;
 *   - a corrected time would leave the selected calendar date (punches are
 *     read by calendar date, so such a punch would drop out of every read);
 *   - a matching punch already carries an active correction (revert it
 *     first - the database's UNIQUE active-punch key enforces this as well);
 *   - any affected employee's attendance month is payroll-locked.
 *
 * ADMINISTRATORS ONLY: the route refuses anyone whose token is not
 * `user_type` 2, and every entry point here checks the actor again.
 */


/** Twelve hours either way is more than any clock error this is for. */
const MAX_OFFSET_MINUTES = 12 * 60;
const MIN_TEXT_LENGTH = 5;
const MAX_TEXT_LENGTH = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function validationError(message, code = null) {
  const err = new Error(message);
  err.name = "ValidationError";
  if (code) err.code = code;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
}

function conflictError(message, code) {
  const err = new Error(message);
  err.name = "ConflictError";
  err.code = code;
  err.httpCode = 409;
  return err;
}

function forbiddenError() {
  // The permission middleware's own sentence: the web app treats any other
  // 403 as a dead session and signs the user out.
  const err = new Error("You do not have permission to perform this action");
  err.name = "ForbiddenError";
  err.code = "ADMIN_ONLY";
  err.httpCode = 403;
  return err;
}

function assertAdmin(actor) {
  if (!actor || Number(actor.user_type) !== ADMIN_USER_TYPE) throw forbiddenError();
}

/** `H:MM`, `HH:MM` or `HH:MM:SS` -> `HH:MM:SS`, else null. */
function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value === undefined || value === null ? "" : value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || mi > 59 || se > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(se).padStart(2, "0")}`;
}

/**
 * `YYYY-MM-DD HH:MM:SS` + minutes, by UTC arithmetic on the wall-clock
 * fields. No timezone is applied anywhere: the value is an IST wall-clock
 * time in and an IST wall-clock time out, exactly as `biomax_punch.io_time`.
 */
function addMinutesToIoTime(ioTime, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(ioTime || "").trim());
  if (!m) return null;
  const ms =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) +
    Number(minutes) * 60000;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes()
  )}:${pad(d.getUTCSeconds())}`;
}

const optionalId = (value) =>
  value === undefined || value === null || value === "" ? null : Number(value);

/**
 * The fingerprint of a previewed punch set: the criteria and, for every
 * punch, its id, raw time, employee, active correction and void. A punch
 * arriving, being re-matched, voided or corrected by another batch between
 * Preview and Apply changes it - and so does changing the offset or window.
 */
function fingerprintOf(criteria, punches) {
  const canonical = {
    date: criteria.date,
    device: Number(criteria.biomax_device_id),
    outlet: criteria.outlet_id === null || criteria.outlet_id === undefined ? null : Number(criteria.outlet_id),
    from: criteria.window_from,
    to: criteria.window_to,
    offset: Number(criteria.offset_minutes),
    punches: (punches || [])
      .map((p) => [
        String(p.biomax_punch_id),
        p.io_time,
        p.employee_id === null || p.employee_id === undefined ? null : Number(p.employee_id),
        p.active_correction_id === null || p.active_correction_id === undefined ? null : Number(p.active_correction_id),
        p.attendance_punch_void_id === null || p.attendance_punch_void_id === undefined
          ? null
          : Number(p.attendance_punch_void_id),
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

module.exports = (repo, attendanceCalculationUsecase, options = {}) => {
  const today = () => istToday(typeof options.today === "function" ? options.today() : options.today || null);

  /**
   * The administrator's input, checked, in the shape every step uses. Reads
   * the device (and its location periods) to validate the outlet; writes
   * nothing.
   */
  const validateCriteria = async (input = {}) => {
    const date = toDateOnly(input.date);
    if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.date || "").trim())) {
      throw validationError("date must be a date as YYYY-MM-DD");
    }
    if (date > today()) throw validationError("date cannot be in the future");

    const deviceId = Number(input.biomax_device_id);
    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      throw validationError("biomax_device_id is required - choose the affected attendance device");
    }

    const fromTime = parseClock(input.from_time);
    const toTime = parseClock(input.to_time);
    if (fromTime === null) throw validationError("from_time must be a time as HH:MM or HH:MM:SS");
    if (toTime === null) throw validationError("to_time must be a time as HH:MM or HH:MM:SS");
    if (fromTime > toTime) throw validationError("from_time must not be after to_time");

    const offset = Number(input.offset_minutes);
    if (!Number.isInteger(offset) || offset === 0) {
      throw validationError("offset_minutes must be a whole, non-zero number of minutes (e.g. 150 or -30)");
    }
    if (Math.abs(offset) > MAX_OFFSET_MINUTES) {
      throw validationError(`offset_minutes may be at most ${MAX_OFFSET_MINUTES} minutes either way`);
    }

    const reasonCode = String(input.reason_code || "").trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(REASON_CODES, reasonCode)) {
      throw validationError(`reason_code must be one of: ${Object.keys(REASON_CODES).join(", ")}`);
    }
    const remarks = typeof input.remarks === "string" ? input.remarks.trim() : "";
    if (remarks.length < MIN_TEXT_LENGTH) {
      throw validationError(
        `remarks of at least ${MIN_TEXT_LENGTH} characters are required - say how the offset was established`
      );
    }
    if (remarks.length > MAX_TEXT_LENGTH) throw validationError(`remarks may be at most ${MAX_TEXT_LENGTH} characters`);

    const device = await repo.getDevice(deviceId);
    if (!device) throw notFoundError(`No registered attendance device exists for id ${deviceId}`);

    const windowFrom = `${date} ${fromTime}`;
    const windowTo = `${date} ${toTime}`;

    const outletId = optionalId(input.outlet_id);
    let outletName = null;
    if (outletId !== null) {
      if (!Number.isInteger(outletId) || outletId <= 0) throw validationError("outlet_id must be an outlet id");
      // The device must actually have been assigned to that outlet at some
      // moment of the window, else the outlet filter is a typo that would
      // quietly match nothing.
      const overlapping = (device.assignments || []).filter(
        (a) =>
          Number(a.outlet_id) === outletId &&
          a.effective_from <= windowTo &&
          (a.effective_to === null || a.effective_to === undefined || a.effective_to > windowFrom)
      );
      if (overlapping.length === 0) {
        throw validationError(
          `Device ${device.label || device.dev_id} was not assigned to outlet ${outletId} during ${windowFrom} - ${windowTo}`
        );
      }
      outletName = overlapping[0].outlet_name || null;
    }

    return {
      date,
      biomax_device_id: deviceId,
      dev_id: device.dev_id,
      device_label: device.label || null,
      outlet_id: outletId,
      outlet_name: outletName,
      from_time: fromTime,
      to_time: toTime,
      window_from: windowFrom,
      window_to: windowTo,
      offset_minutes: offset,
      reason_code: reasonCode,
      reason_label: REASON_CODES[reasonCode],
      remarks,
    };
  };

  /** What the criteria would do to each punch, and what stops it. Pure. */
  const buildPlan = (criteria, punches) => {
    const items = (punches || []).map((p) => {
      const corrected = addMinutesToIoTime(p.io_time, criteria.offset_minutes);
      const employeeId =
        p.employee_id === null || p.employee_id === undefined || Number(p.employee_id) <= 0
          ? null
          : Number(p.employee_id);
      return {
        biomax_punch_id: Number(p.biomax_punch_id),
        employee_id: employeeId,
        employee_code: p.user_id,
        employee_name: p.employee_name || null,
        original_io_time: p.io_time,
        corrected_io_time: corrected,
        offset_minutes: criteria.offset_minutes,
        received_at: p.received_at || null,
        device_label: p.device_label || criteria.device_label,
        dev_id: p.dev_id,
        outlet_id: p.punch_outlet_id === null || p.punch_outlet_id === undefined ? null : Number(p.punch_outlet_id),
        outlet_name: p.punch_outlet_name || null,
        ingest_source: p.ingest_source || null,
        voided: !!p.attendance_punch_void_id,
        active_correction_id:
          p.active_correction_id === null || p.active_correction_id === undefined ? null : Number(p.active_correction_id),
        crosses_date: corrected === null || corrected.slice(0, 10) !== criteria.date,
      };
    });

    const blocking = [];
    if (items.length === 0) {
      blocking.push({
        code: "NO_PUNCHES",
        msg: "No punch from this device falls inside the selected date and time window.",
      });
    }
    const crossing = items.filter((i) => i.crosses_date);
    if (crossing.length > 0) {
      blocking.push({
        code: "CROSSES_DATE",
        msg: `${crossing.length} corrected time(s) would fall outside ${criteria.date}. A device time correction cannot move a punch to another calendar date.`,
        biomax_punch_ids: crossing.map((i) => i.biomax_punch_id),
      });
    }
    const already = items.filter((i) => i.active_correction_id !== null);
    if (already.length > 0) {
      blocking.push({
        code: "ALREADY_CORRECTED",
        msg: `${already.length} punch(es) already carry an active device time correction (${[
          ...new Set(already.map((i) => `#${i.active_correction_id}`)),
        ].join(", ")}). Revert that correction first; a punch is never corrected twice.`,
        biomax_punch_ids: already.map((i) => i.biomax_punch_id),
      });
    }

    const employeeIds = [...new Set(items.filter((i) => i.employee_id !== null).map((i) => i.employee_id))];
    const sortedOriginal = items.map((i) => i.original_io_time).sort();
    const sortedCorrected = items.map((i) => i.corrected_io_time).filter(Boolean).sort();
    const summary = {
      punch_count: items.length,
      employee_count: employeeIds.length,
      unmatched_punch_count: items.filter((i) => i.employee_id === null).length,
      voided_punch_count: items.filter((i) => i.voided).length,
      device: { biomax_device_id: criteria.biomax_device_id, dev_id: criteria.dev_id, label: criteria.device_label },
      outlet: criteria.outlet_id === null ? null : { outlet_id: criteria.outlet_id, outlet_name: criteria.outlet_name },
      outlets_seen: [...new Set(items.map((i) => i.outlet_name || "(no location)"))],
      offset_minutes: criteria.offset_minutes,
      earliest_original: sortedOriginal[0] || null,
      earliest_corrected: sortedCorrected[0] || null,
      latest_original: sortedOriginal[sortedOriginal.length - 1] || null,
      latest_corrected: sortedCorrected[sortedCorrected.length - 1] || null,
    };
    return { items, blocking, employeeIds, summary };
  };

  /**
   * employee -> the attendance dates this change touches: the date each punch
   * belongs to under its ORIGINAL time and under its CORRECTED time, by the
   * engine's own cutoff rule. Usually one date; two when a punch near the
   * cutoff changes day - and both must be recalculated and lock-checked.
   */
  const affectedDatesByEmployee = async (criteria, items, { timeKeys }) => {
    const byEmployee = new Map();
    items.forEach((i) => {
      if (i.employee_id === null) return;
      if (!byEmployee.has(i.employee_id)) byEmployee.set(i.employee_id, []);
      byEmployee.get(i.employee_id).push(i);
    });
    const result = new Map();
    for (const [employeeId, list] of byEmployee) {
      const times = [];
      list.forEach((i) => timeKeys.forEach((k) => i[k] && times.push(i[k])));
      /* eslint-disable no-await-in-loop */
      const dated = attendanceCalculationUsecase.attendanceDatesForPunchTimes
        ? await attendanceCalculationUsecase.attendanceDatesForPunchTimes({
            employee_id: employeeId,
            near_date: criteria.date,
            punch_times: times,
          })
        : times.map(() => null);
      /* eslint-enable no-await-in-loop */
      // A time the engine cannot date (no shift) falls back to its calendar
      // date, so the lock check and the recalculation still cover it.
      const dates = new Set(dated.map((d, idx) => d || String(times[idx]).slice(0, 10)));
      result.set(employeeId, [...dates].sort());
    }
    return result;
  };

  const lockRowsFor = (datesByEmployee) => {
    const rows = [];
    datesByEmployee.forEach((dates, employeeId) =>
      dates.forEach((date) => rows.push({ employee_id: employeeId, attendance_date: date }))
    );
    return rows;
  };

  const findLocked = async (lockRows) =>
    lockRows.length > 0 && attendanceCalculationUsecase.findPayrollLockedPeriods
      ? (await attendanceCalculationUsecase.findPayrollLockedPeriods(lockRows)) || []
      : [];

  /**
   * The recalculated days for every affected employee, with `timeOf(item)` as
   * each moved punch's effective time. Calculated here, stored by the
   * repository inside the correction's own transaction.
   */
  const recalculatePlan = async (items, datesByEmployee, timeOf) => {
    const rows = [];
    const perEmployee = [];
    for (const [employeeId, dates] of datesByEmployee) {
      const assume = new Map(
        items.filter((i) => i.employee_id === employeeId).map((i) => [String(i.biomax_punch_id), timeOf(i)])
      );
      /* eslint-disable no-await-in-loop */
      const result = await attendanceCalculationUsecase.calculateForTimeCorrection({
        employee_id: employeeId,
        attendance_dates: dates,
        assume_io_times: assume,
      });
      /* eslint-enable no-await-in-loop */
      rows.push(...result.rows);
      perEmployee.push({
        employee_id: employeeId,
        attendance_dates: dates,
        stored_dates: result.days.map((d) => d.attendance_date),
        open_dates: result.skipped_open_dates.map((s) => ({
          attendance_date: s.attendance_date,
          reason: s.reason || null,
          closes_at: s.closes_at || null,
        })),
        ineligible_dates: result.ineligible_dates,
        days: result.days.map((d) => ({
          attendance_date: d.attendance_date,
          status: d.status,
          punch_count: d.punch_count,
          worked_minutes: d.worked_minutes,
          late_minutes: d.late_minutes,
          early_exit_minutes: d.early_exit_minutes,
          shortage_minutes: d.shortage_minutes,
          candidate_ot_minutes: d.candidate_ot_minutes,
          approved_ot_minutes: d.approved_ot_minutes,
          review_reasons: d.review_reasons || [],
        })),
      });
    }
    return { rows, perEmployee };
  };

  const presentPunch = (i) => ({
    biomax_punch_id: i.biomax_punch_id,
    employee_id: i.employee_id,
    employee_code: i.employee_code,
    employee_name: i.employee_name,
    original_punch: i.original_io_time,
    corrected_punch: i.corrected_io_time,
    received_at: i.received_at,
    device: i.device_label,
    dev_id: i.dev_id,
    outlet: i.outlet_name,
    voided: i.voided,
    already_corrected_by: i.active_correction_id,
    crosses_date: i.crosses_date,
  });

  /**
   * PREVIEW. Reads only: the device, the matching punches, the dates they
   * belong to, the payroll locks and the pending requests. Writes nothing.
   */
  const preview = async (input, actor) => {
    assertAdmin(actor);
    const criteria = await validateCriteria(input);
    const punches = await repo.selectCandidatePunches(criteria);
    const plan = buildPlan(criteria, punches);

    const datesByEmployee = await affectedDatesByEmployee(criteria, plan.items, {
      timeKeys: ["original_io_time", "corrected_io_time"],
    });
    const lockRows = lockRowsFor(datesByEmployee);
    const locked = await findLocked(lockRows);
    const blocking = [...plan.blocking];
    if (locked.length > 0) {
      blocking.push({
        code: "PAYROLL_MONTH_LOCKED",
        msg: payrollLockedActionError(locked, "This device time correction").message,
        locked_months: locked,
      });
    }

    const allDates = [...new Set(lockRows.map((r) => r.attendance_date))];
    const pending = repo.findPendingRequests ? await repo.findPendingRequests(plan.employeeIds, allDates) : [];
    const warnings = [];
    if (pending.length > 0) {
      warnings.push({
        code: "PENDING_REQUESTS",
        msg: `${pending.length} pending attendance/OT request(s) exist on the affected date(s). Their approvers will see the corrected punch times.`,
        requests: pending,
      });
    }
    if (plan.summary.voided_punch_count > 0) {
      warnings.push({
        code: "VOIDED_PUNCHES",
        msg: `${plan.summary.voided_punch_count} matching punch(es) are voided. Their time is corrected for the record; they still do not count.`,
      });
    }
    if (plan.summary.unmatched_punch_count > 0) {
      warnings.push({
        code: "UNMATCHED_PUNCHES",
        msg: `${plan.summary.unmatched_punch_count} matching punch(es) are not matched to an employee. Their time is corrected; there is no attendance to recalculate for them yet.`,
      });
    }

    return {
      code: 200,
      batch_ref: crypto.randomUUID(),
      preview_fingerprint: fingerprintOf(criteria, punches),
      criteria,
      summary: plan.summary,
      affected_attendance_dates: [...datesByEmployee].map(([employee_id, dates]) => ({ employee_id, dates })),
      can_apply: blocking.length === 0,
      blocking_issues: blocking,
      warnings,
      punches: plan.items.map(presentPunch),
    };
  };

  /**
   * APPLY. Requires the batch ID and fingerprint the preview issued.
   */
  const apply = async (input, actor) => {
    assertAdmin(actor);
    const batchRef = String(input.batch_ref || "").trim().toLowerCase();
    if (!UUID_RE.test(batchRef)) throw validationError("batch_ref must be the batch ID the preview issued");
    const expected = String(input.preview_fingerprint || "").trim().toLowerCase();
    if (!FINGERPRINT_RE.test(expected)) {
      throw validationError("preview_fingerprint must be the fingerprint the preview issued - preview first");
    }

    const criteria = await validateCriteria(input);

    const existing = await repo.findByBatchRef(batchRef);
    if (existing) {
      throw conflictError(
        `Correction batch ${batchRef} has already been applied (#${existing.attendance_device_time_correction_id}).`,
        "ALREADY_APPLIED"
      );
    }

    // REVALIDATE: the same criteria must still select the same punches.
    const punches = await repo.selectCandidatePunches(criteria);
    if (fingerprintOf(criteria, punches) !== expected) {
      throw conflictError(
        "The punches for this device and time window have changed since the preview. Preview again before applying.",
        "PREVIEW_STALE"
      );
    }
    const plan = buildPlan(criteria, punches);
    if (plan.blocking.length > 0) {
      throw validationError(plan.blocking.map((b) => b.msg).join(" "), plan.blocking[0].code);
    }

    const datesByEmployee = await affectedDatesByEmployee(criteria, plan.items, {
      timeKeys: ["original_io_time", "corrected_io_time"],
    });
    const lockRows = lockRowsFor(datesByEmployee);
    const locked = await findLocked(lockRows);
    if (locked.length > 0) throw payrollLockedActionError(locked, "This device time correction");

    const { rows, perEmployee } = await recalculatePlan(plan.items, datesByEmployee, (i) => i.corrected_io_time);

    const stored = await repo.applyCorrection({
      criteria,
      expected_fingerprint: expected,
      fingerprintOf: (current) => fingerprintOf(criteria, current),
      batch: {
        batch_ref: batchRef,
        correction_date: criteria.date,
        biomax_device_id: criteria.biomax_device_id,
        dev_id: criteria.dev_id,
        device_label: criteria.device_label,
        outlet_id: criteria.outlet_id,
        window_from: criteria.window_from,
        window_to: criteria.window_to,
        offset_minutes: criteria.offset_minutes,
        reason_code: criteria.reason_code,
        remarks: criteria.remarks,
        punch_count: plan.summary.punch_count,
        employee_count: plan.summary.employee_count,
        applied_by_employee_id: actor.employee_id === undefined ? null : actor.employee_id,
        applied_by_user_id: actor.user_id === undefined ? null : actor.user_id,
      },
      items: plan.items.map((i) => ({
        biomax_punch_id: i.biomax_punch_id,
        employee_id: i.employee_id,
        original_io_time: i.original_io_time,
        corrected_io_time: i.corrected_io_time,
        offset_minutes: i.offset_minutes,
      })),
      lock_rows: lockRows,
      calculation_rows: rows,
    });

    const openCount = perEmployee.reduce((n, e) => n + e.open_dates.length, 0);
    return {
      code: 200,
      attendance_device_time_correction_id: stored.attendance_device_time_correction_id,
      batch_ref: batchRef,
      status: "APPLIED",
      summary: plan.summary,
      days_stored: rows.length,
      recalculation: perEmployee,
      msg:
        `Device time correction applied to ${plan.summary.punch_count} punch(es) of ${plan.summary.employee_count} employee(s).` +
        (openCount > 0
          ? ` ${openCount} attendance day(s) are still open: they read live with the corrected times and are stored by the first recalculation after they close.`
          : ""),
    };
  };

  /**
   * REVERT. The batch must be APPLIED and every affected month unlocked.
   */
  const revert = async ({ correction_id, reason }, actor) => {
    assertAdmin(actor);
    const id = Number(correction_id);
    if (!Number.isInteger(id) || id <= 0) throw validationError("correction id must be a device time correction id");
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed.length < MIN_TEXT_LENGTH) {
      throw validationError(`A reason of at least ${MIN_TEXT_LENGTH} characters is required to revert`);
    }
    if (trimmed.length > MAX_TEXT_LENGTH) throw validationError(`The reason may be at most ${MAX_TEXT_LENGTH} characters`);

    const batch = await repo.getCorrection(id);
    if (!batch) throw notFoundError(`No device time correction exists for id ${id}`);
    if (batch.status !== "APPLIED") {
      throw conflictError(`Device time correction #${id} has already been reverted.`, "ALREADY_REVERTED");
    }

    const items = (batch.punches || [])
      .filter((p) => Number(p.is_active) === 1)
      .map((p) => ({
        biomax_punch_id: Number(p.biomax_punch_id),
        employee_id: p.employee_id === null || p.employee_id === undefined ? null : Number(p.employee_id),
        original_io_time: p.original_io_time,
        corrected_io_time: p.corrected_io_time,
      }));

    const datesByEmployee = await affectedDatesByEmployee({ date: batch.correction_date }, items, {
      timeKeys: ["original_io_time", "corrected_io_time"],
    });
    const lockRows = lockRowsFor(datesByEmployee);
    const locked = await findLocked(lockRows);
    if (locked.length > 0) throw payrollLockedActionError(locked, "Reverting this device time correction");

    const { rows, perEmployee } = await recalculatePlan(items, datesByEmployee, (i) => i.original_io_time);

    await repo.revertCorrection({
      correction_id: id,
      expected_active_punch_ids: items.map((i) => i.biomax_punch_id),
      actor: {
        employee_id: actor.employee_id === undefined ? null : actor.employee_id,
        user_id: actor.user_id === undefined ? null : actor.user_id,
      },
      reason: trimmed,
      lock_rows: lockRows,
      calculation_rows: rows,
    });

    const openCount = perEmployee.reduce((n, e) => n + e.open_dates.length, 0);
    return {
      code: 200,
      attendance_device_time_correction_id: id,
      status: "REVERTED",
      punch_count: items.length,
      days_stored: rows.length,
      recalculation: perEmployee,
      msg:
        `Device time correction #${id} reverted: ${items.length} punch(es) use their original device time again.` +
        (openCount > 0
          ? ` ${openCount} attendance day(s) are still open and are stored by the first recalculation after they close.`
          : ""),
    };
  };

  const withLabel = (row) => ({ ...row, reason_label: REASON_CODES[row.reason_code] || row.reason_code });

  const list = async ({ limit } = {}, actor) => {
    assertAdmin(actor);
    const rows = await repo.listCorrections(limit);
    return { code: 200, data: rows.map(withLabel) };
  };

  const get = async (correction_id, actor) => {
    assertAdmin(actor);
    const id = Number(correction_id);
    if (!Number.isInteger(id) || id <= 0) throw validationError("correction id must be a device time correction id");
    const batch = await repo.getCorrection(id);
    if (!batch) throw notFoundError(`No device time correction exists for id ${id}`);
    const { preview_fingerprint, ...rest } = batch;
    return { code: 200, data: withLabel(rest) };
  };

  const options_ = async (actor) => {
    assertAdmin(actor);
    const devices = await repo.listDevices();
    return {
      code: 200,
      devices,
      reason_codes: Object.entries(REASON_CODES).map(([code, label]) => ({ code, label })),
      max_offset_minutes: MAX_OFFSET_MINUTES,
    };
  };

  return { preview, apply, revert, list, get, options: options_, validateCriteria, buildPlan };
};

module.exports.REASON_CODES = REASON_CODES;
module.exports.MAX_OFFSET_MINUTES = MAX_OFFSET_MINUTES;
module.exports.addMinutesToIoTime = addMinutesToIoTime;
module.exports.parseClock = parseClock;
module.exports.fingerprintOf = fingerprintOf;
