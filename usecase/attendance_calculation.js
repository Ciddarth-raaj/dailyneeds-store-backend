const {
  CALCULATION_VERSION,
  CALC_STATUS,
  PUNCH_SOURCE,
  calculateAttendanceDay,
  attendanceDateForPunch,
  addDays,
} = require("../utils/attendance_engine");
const {
  RESOLUTION_STATUS,
  resolveShiftForDate,
  toDateOnly,
} = require("../utils/shiftResolution");
const {
  resolveConfigVersionForDate,
  toShiftDefinition,
} = require("../utils/shift_config_version");
const {
  PAYROLL_VERSION,
  computeMonthlyAttendancePayroll,
  daysInMonth,
} = require("../utils/attendance_payroll");

/**
 * Attendance v2 - the orchestration between the repository and the pure
 * engines.
 *
 * The arithmetic is NOT here. `utils/attendance_engine.js` decides worked
 * minutes, `utils/shiftResolution.js` decides which shift applied,
 * `utils/shift_config_version.js` decides which VERSION of that shift applied,
 * and `utils/attendance_payroll.js` decides the month; this file fetches what
 * they need, calls them in the right order, and shapes the result for storage.
 * That separation is what lets the whole of the business rule be tested as
 * arithmetic and lets this file be tested against a fake repository.
 *
 * RECALCULATION STARTS FROM RAW PUNCHES, NOT FROM A STORED DERIVED DATE
 * (review fix #1). The engine reads `biomax_punch` over a CALENDAR window and
 * re-derives every punch's attendance date itself, from the shift that was
 * assigned on the relevant date and from THAT shift version's own cutoff. It
 * does not read `biomax_punch_derived.attendance_date`, which was written at
 * ingest against whatever shift the employee was on at the time and cannot be
 * re-derived by anybody afterwards. `biomax_punch_derived` is preserved and
 * still written by the receiver exactly as before - it remains the ingest-time
 * audit record and the existing Attendance screens keep reading it - but the
 * v2 engine reproduces the attendance-day assignment independently, which is
 * what makes a recalculation a genuine recalculation.
 *
 * The window is widened by ONE DAY at the end, and by nothing at the start,
 * because the cutoff rule can only ever move a punch BACKWARDS onto the
 * previous attendance date: a 00:30 finish on the 15th belongs to the 14th,
 * and no rule anywhere moves a punch forwards.
 *
 * Everything else is still derived from the immutable raw punches plus the
 * dated shift history plus the fully approved regularizations, so running it
 * twice produces the same rows and running it after an approval produces the
 * corrected ones. Nothing accumulates and nothing is incremented.
 */

/** The most dates one request may recalculate, so a typo cannot scan a decade. */
const MAX_RANGE_DAYS = 62;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** Every date from `from` to `to` inclusive, as `YYYY-MM-DD`. */
function dateRange(from, to) {
  const dates = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard <= MAX_RANGE_DAYS) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

/**
 * The employee's Special Break Duration Override, or null.
 *
 * ONE CURRENT VALUE, NO EFFECTIVE DATE (review fix #7). The approved v2
 * product contract gives Employee Master a single `Special Break Duration
 * Override` field with no Effective From, and this reads exactly that: the
 * column on the employee row. There is no second temporal business rule here
 * and no dated override table - the earlier implementation invented one, and
 * it has been removed rather than carried forward.
 */
function breakOverrideMinutes(row) {
  if (!row) return null;
  const value = row.special_break_override_minutes;
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/** The OT claim states a day can be in. Separate from the attendance status. */
const OT_CLAIM_STATE = Object.freeze({
  NONE: "NONE",
  AVAILABLE: "AVAILABLE",
  REQUEST_PENDING: "REQUEST_PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CLOSED_AT_PAYROLL_LOCK: "CLOSED_AT_PAYROLL_LOCK",
});

/**
 * The OT claim on a calculated day, from the OT request against it (if any).
 *
 *   NONE                    no candidate OT and nothing requested
 *   AVAILABLE               the engine found candidate OT and nobody asked yet
 *   REQUEST_PENDING         the employee asked and the chain is not finished
 *   APPROVED                finally approved; `approved_ot_minutes` is paid
 *   REJECTED                an approver rejected it
 *   CLOSED_AT_PAYROLL_LOCK  closed by the payroll lock, never requested or
 *                           never approved in time (`ot_closure_reason` says
 *                           which)
 *
 * Only a complete FINAL day can offer OT: an incomplete day's overtime is
 * a guess until the missing punch is supplied, and that is a regularization.
 */
function otClaimFor({ day, otRequest, otSettled }) {
  const candidate = Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0));
  const claim = {
    ot_claim_state: OT_CLAIM_STATE.NONE,
    ot_request_id: otRequest ? otRequest.attendance_approval_request_id : null,
    ot_requested_minutes: otRequest ? Number(otRequest.candidate_ot_minutes || 0) : null,
    ot_reason: otRequest ? otRequest.reason || null : null,
    ot_closure_reason: otRequest ? otRequest.closure_reason || null : null,
    ot_requested_at: otRequest ? otRequest.created_at || null : null,
    ot_decided_at: otRequest ? otRequest.decided_at || null : null,
  };

  if (otRequest) {
    if (otRequest.status === "PENDING" || (otRequest.status === "APPROVED" && !otSettled)) {
      claim.ot_claim_state = OT_CLAIM_STATE.REQUEST_PENDING;
    } else if (otRequest.status === "APPROVED") {
      claim.ot_claim_state = OT_CLAIM_STATE.APPROVED;
    } else if (otRequest.closure_reason) {
      claim.ot_claim_state = OT_CLAIM_STATE.CLOSED_AT_PAYROLL_LOCK;
    } else {
      claim.ot_claim_state = OT_CLAIM_STATE.REJECTED;
    }
    return claim;
  }

  if (candidate > 0 && day.is_final === true && day.status === CALC_STATUS.FINAL) {
    claim.ot_claim_state = OT_CLAIM_STATE.AVAILABLE;
  }
  return claim;
}

module.exports = (attendanceCalculationRepo, options = {}) => {
  /**
   * The OT request collaborator, injected rather than required.
   *
   * It lives in `usecase/attendance_regularization.js`, which already depends
   * on THIS usecase, so wiring it the other way round as a constructor
   * argument would be a cycle. `server.js` builds both and then hands this one
   * the service. It is consulted for exactly one thing: closing unresolved OT
   * when a payroll month is locked (`closeOtForPayrollLock` below). NOTHING
   * here raises an OT request: candidate overtime is a figure the engine
   * reports, and it becomes a request only when the employee asks for it.
   */
  let otRequestService = options.ot_request_service || null;
  const setOtRequestService = (service) => {
    otRequestService = service || null;
  };

  /**
   * Read every shift a history references, once - both its LIVE definition and
   * its effective-dated configuration VERSIONS.
   *
   * A month typically touches one shift; a month that spans a roster change
   * touches two. Either way each one is fetched once and the resolver reads
   * from memory, rather than a query per date.
   */
  const loadShiftCache = async (assignments) => {
    const ids = [...new Set((assignments || []).map((a) => Number(a.work_shift_id)))];
    const cache = new Map();
    for (const id of ids) {
      // Sequential on purpose: a handful of ids, and the pool is shared with
      // every other request on this process.
      /* eslint-disable no-await-in-loop */
      const live = await attendanceCalculationRepo.getWorkShiftWithSchedule(id);
      const versions = attendanceCalculationRepo.getWorkShiftConfigVersions
        ? await attendanceCalculationRepo.getWorkShiftConfigVersions(id)
        : [];
      /* eslint-enable no-await-in-loop */
      if (live || (versions && versions.length > 0)) cache.set(id, { live, versions });
    }
    return cache;
  };

  /**
   * Everything a range needs, loaded once, plus the readers the pure resolvers
   * consume. Shared by the preview, the stored recalculation and the
   * proposed-punch calculation, so all three see one definition of "what
   * applied on this date".
   */
  const buildContext = async ({ employee_id, from, to, assume_override = null }) => {
    // ONE day of slack at the END only - see the file header. A punch on the
    // morning after `to` can belong to `to`; a punch before `from` can never
    // belong to `from`.
    const punchWindowTo = addDays(to, 1);

    const [assignments, rawPunches, regularized, employee, approvals, storedOverrides] =
      await Promise.all([
        attendanceCalculationRepo.getShiftAssignmentHistory(employee_id),
        attendanceCalculationRepo.getRawPunchesByCalendarWindow(employee_id, from, punchWindowTo),
        attendanceCalculationRepo.getApprovedRegularizedPunches(employee_id, from, to),
        attendanceCalculationRepo.getBreakOverride(employee_id),
        attendanceCalculationRepo.getApprovalStateByDate(employee_id, from, to),
        // Single-date overrides. The cutoff rule can date a punch one day back,
        // so the day AFTER `to` is read as well: dating that punch needs the
        // shift that applied on its own date.
        attendanceCalculationRepo.getDateShiftOverrides
          ? attendanceCalculationRepo.getDateShiftOverrides(employee_id, from, punchWindowTo)
          : [],
      ]);

    // An override that is being SAVED joins the stored ones in memory only, so
    // the day can be calculated under it inside the transaction that records
    // it. It carries the greatest id by construction, so it wins the date.
    const overrides = [...(storedOverrides || [])];
    if (assume_override) {
      overrides.push({
        attendance_date_shift_override_id: Number.MAX_SAFE_INTEGER,
        employee_id,
        attendance_date: toDateOnly(assume_override.attendance_date),
        work_shift_id: Number(assume_override.work_shift_id),
      });
    }

    const shiftCache = await loadShiftCache([...(assignments || []), ...overrides]);

    // (shift, date) -> the configuration VERSION in force then. Memoized
    // because a month resolves the same pair thirty times.
    const definitions = new Map();
    const definitionFor = (workShiftId, date) => {
      const key = `${workShiftId}|${date}`;
      if (definitions.has(key)) return definitions.get(key);

      const loaded = shiftCache.get(Number(workShiftId));
      let definition = null;
      if (loaded) {
        const versionRow = resolveConfigVersionForDate(loaded.versions, date);
        definition = versionRow
          ? toShiftDefinition(versionRow, workShiftId)
          : // Before the first version row there is nothing dated to read, so
            // the live tables answer and say so. The migration seeds a version
            // at the v2 cutover, so this is only reachable for dates earlier
            // than v2 itself.
            loaded.live
            ? { ...loaded.live, config_version_id: null, config_version_hash: null, config_effective_from: null, from_live: true }
            : null;
      }
      definitions.set(key, definition);
      return definition;
    };

    const readSchedule = (workShiftId, dow, date) => {
      const definition = definitionFor(workShiftId, date);
      if (!definition) return null;
      return definition.schedule.find((row) => Number(row.day_of_week) === Number(dow)) || null;
    };

    const readShiftConfig = (workShiftId, date) => {
      const definition = definitionFor(workShiftId, date);
      if (!definition) return null;
      return {
        ...definition.config,
        config_version_id: definition.config_version_id || null,
        config_version_hash: definition.config_version_hash || null,
        config_effective_from: definition.config_effective_from || null,
      };
    };

    // The shift that applied on a date, memoized. Used both to calculate a
    // date and - one day earlier - to date a punch.
    const resolutions = new Map();
    const resolutionFor = (date) => {
      if (resolutions.has(date)) return resolutions.get(date);
      const resolution = resolveShiftForDate({
        assignments,
        overrides,
        attendanceDate: date,
        readSchedule,
        readShiftConfig,
      });
      resolutions.set(date, resolution);
      return resolution;
    };

    /** The shift's display name, from the live master row. Null if unknown. */
    const shiftNameFor = (workShiftId) => {
      const loaded = shiftCache.get(Number(workShiftId));
      const config = loaded && loaded.live ? loaded.live.config : null;
      return config && config.shift_name ? config.shift_name : null;
    };

    /**
     * The cutoff that applied on a date, for re-dating a punch (review fix #1).
     *
     * It goes through the SAME dated assignment history and the SAME dated
     * configuration version as the calculation does, so the attendance day a
     * punch lands on is reproducible from history rather than inherited from
     * whatever shift the employee happens to be on today.
     */
    const readCutoff = (date) => {
      const resolution = resolutionFor(date);
      if (!resolution || !resolution.snapshot) return null;
      return {
        is_working_day: resolution.snapshot.is_working_day,
        attendance_day_cutoff: resolution.snapshot.attendance_day_cutoff,
      };
    };

    return {
      assignments,
      rawPunches,
      regularized,
      approvals,
      break_override_minutes: breakOverrideMinutes(employee),
      resolutionFor,
      readCutoff,
      shiftNameFor,
    };
  };

  /**
   * Raw punches, re-dated to the attendance day they belong to and grouped by
   * it. Anything that lands outside the requested range is dropped.
   */
  const groupRawPunchesByAttendanceDate = ({ rawPunches, readCutoff, from, to }) => {
    const byDate = new Map();
    (rawPunches || []).forEach((punch) => {
      const derived = attendanceDateForPunch({ ioTime: punch.io_time, readCutoff });
      if (derived === null || derived < from || derived > to) return;
      if (!byDate.has(derived)) byDate.set(derived, []);
      byDate.get(derived).push({
        punch_id: punch.punch_id,
        source: punch.ingest_source === "IMPORT" ? PUNCH_SOURCE.IMPORT : PUNCH_SOURCE.BIOMAX,
        dev_id: punch.dev_id,
        io_time: punch.io_time,
        // What ingest thought, kept beside what the engine derived, so a
        // disagreement is visible instead of silent.
        ingest_attendance_date: punch.ingest_attendance_date || null,
        attendance_date: derived,
      });
    });
    return byDate;
  };

  /**
   * Calculate one employee over a date range, WITHOUT writing anything.
   *
   * Used by the preview endpoint, by `recalculateRange` below and by the
   * approval path, so what a reviewer is shown, what gets stored and what an
   * approval settles are all produced by one code path.
   *
   * `assume` lets a caller calculate a date AS IF one approval request had
   * already been decided, without that decision being visible to anybody else
   * yet. It is how a final approval computes the corrected day inside the very
   * transaction that approves it (review fix #4), and how a proposed
   * regularized punch is priced before anyone has agreed to it (review fix #3).
   * It changes nothing in the database by itself.
   */
  const calculateRange = async ({
    employee_id,
    from_date,
    to_date,
    assume = null,
    assume_override = null,
  }) => {
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }
    if (from > to) throw validationError("from_date must not be after to_date");

    const dates = dateRange(from, to);
    if (dates.length > MAX_RANGE_DAYS) {
      throw validationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
    }

    const context = await buildContext({ employee_id, from, to, assume_override });
    const rawByDate = groupRawPunchesByAttendanceDate({
      rawPunches: context.rawPunches,
      readCutoff: context.readCutoff,
      from,
      to,
    });

    const regularizedByDate = new Map();
    (context.regularized || []).forEach((row) => {
      const date = toDateOnly(row.attendance_date);
      if (date === null) return;
      if (!regularizedByDate.has(date)) regularizedByDate.set(date, []);
      regularizedByDate.get(date).push(row);
    });

    // TWO SLOTS PER DATE, because Missing Punch and OT are two separate
    // requests now. `regularization` is the attendance correction (a
    // REGULARIZATION request, or a legacy REGULARIZATION_WITH_OT one); `ot`
    // is the employee's OT claim (an OT request). Among several rows of one
    // kind the newest wins, which is the one that is not CANCELLED.
    const approvalByDate = new Map();
    (context.approvals || []).forEach((row) => {
      const date = toDateOnly(row.attendance_date);
      if (!approvalByDate.has(date)) approvalByDate.set(date, { regularization: null, ot: null });
      const slot = approvalByDate.get(date);
      if (row.request_type === "OT") slot.ot = row;
      else slot.regularization = row;
    });

    const assumedDate = assume ? toDateOnly(assume.attendance_date) : null;

    return dates.map((date) => {
      const resolution = context.resolutionFor(date);

      const slots = approvalByDate.get(date) || { regularization: null, ot: null };
      let approval = slots.regularization;
      let otRequest = slots.ot;
      let regularizedPunches = regularizedByDate.get(date) || [];

      if (assumedDate !== null && assumedDate === date) {
        // The assumption REPLACES whatever is stored for this date's request
        // OF THAT KIND: a decision that has not been committed yet is not in
        // the tables the context read, and a stale stored row must not leak
        // past it. `assume.request_type` says which slot; anything but OT is
        // the attendance correction.
        const assumed = {
          attendance_approval_request_id: assume.attendance_approval_request_id || null,
          attendance_date: date,
          request_type: assume.request_type || "REGULARIZATION",
          status: assume.status,
          candidate_ot_minutes:
            assume.candidate_ot_minutes === undefined ? null : assume.candidate_ot_minutes,
          approved_ot_minutes: assume.approved_ot_minutes || 0,
          reason: assume.reason === undefined ? null : assume.reason,
          closure_reason: null,
          // An assumed APPROVED decision is being SETTLED in the very
          // transaction that is asking for this day: the row it produces is
          // the settled one, committed with the approval.
          finalization_state: assume.status === "APPROVED" ? "SETTLED" : "NOT_REQUIRED",
        };
        if (assumed.request_type === "OT") {
          otRequest = assumed;
        } else {
          approval = assumed;
          regularizedPunches =
            assume.status === "APPROVED" && assume.regularized_punch
              ? [assume.regularized_punch]
              : [];
        }
      }

      // Only a SETTLED approval is payroll-effective (review fix #4). The
      // decision and the recalculated day commit together, so APPROVED implies
      // SETTLED; requiring it here as well means that an APPROVED request whose
      // day was somehow never recalculated holds the date out of payroll
      // instead of paying overtime against stale attendance.
      const isSettled = (row) =>
        !!row &&
        row.status === "APPROVED" &&
        (row.finalization_state === undefined ||
          row.finalization_state === null ||
          row.finalization_state === "SETTLED");

      const regularizationSettled = isSettled(approval);
      const otSettled = isSettled(otRequest);

      // Finally approved OT comes from the settled OT request. A legacy
      // REGULARIZATION_WITH_OT request that was approved before the flows
      // were separated still pays what it approved, so history is not
      // silently re-priced.
      const approvedOt = otSettled
        ? Number(otRequest.approved_ot_minutes || 0)
        : regularizationSettled && approval.request_type === "REGULARIZATION_WITH_OT"
        ? Number(approval.approved_ot_minutes || 0)
        : 0;
      const stillOpen =
        !!approval &&
        (approval.status === "PENDING" || (approval.status === "APPROVED" && !regularizationSettled));

      const calculated = calculateAttendanceDay({
        employee_id,
        attendance_date: date,
        shift: resolution.snapshot,
        shift_status: resolution.status,
        punches: rawByDate.get(date) || [],
        regularized_punches: regularizedPunches.map((p) => ({
          punch_id: p.punch_id === undefined ? null : p.punch_id,
          source: PUNCH_SOURCE.REGULARIZED,
          io_time: p.io_time,
        })),
        break_override_minutes: context.break_override_minutes,
        approved_ot_minutes: approvedOt,
        regularization_pending: stillOpen,
      });

      return {
        ...calculated,
        ...otClaimFor({ day: calculated, otRequest, otSettled }),
        shift_resolution_status: resolution.status,
        // Display only: the live shift name, and whether the date's shift came
        // from the dated history or from a single-date edit.
        shift_name: resolution.work_shift_id ? context.shiftNameFor(resolution.work_shift_id) : null,
        shift_source: resolution.assignment ? resolution.assignment.source || null : null,
        approval_request_id: approval
          ? approval.attendance_approval_request_id
          : otRequest
          ? otRequest.attendance_approval_request_id
          : null,
      };
    });
  };

  /**
   * One date calculated as if a PROPOSED regularized punch were already
   * effective (review fix #3).
   *
   * The proposed punch joins the effective punch list IN MEMORY ONLY. Nothing
   * is written, no request is created, and the stored calculation for the date
   * is untouched; what comes back is what the day WOULD look like, which is
   * what the candidate OT on a missing-punch request has to be derived from.
   * Deriving it from the odd-punch day instead - which is what the first
   * implementation did - always gives zero, because an odd punch count exits
   * the engine before OT is calculated at all.
   */
  const calculateProposedDay = async ({ employee_id, attendance_date, punch_time }) => {
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    const [day] = await calculateRange({
      employee_id,
      from_date: date,
      to_date: date,
      assume: {
        attendance_date: date,
        status: "APPROVED",
        approved_ot_minutes: 0,
        regularized_punch: { punch_id: null, io_time: punch_time },
      },
    });
    return day;
  };

  /**
   * Which attendance date a punch time would belong to, under the historical
   * shift and cutoff for that date (review fix #3).
   *
   * A proposed 00:30 OUT has to land on the date the request is about. If it
   * does not, the request would be approving a punch for a different day, and
   * the raise path refuses it rather than silently moving it.
   */
  const attendanceDateForPunchTime = async ({ employee_id, punch_time, near_date }) => {
    const anchor = toDateOnly(near_date) || toDateOnly(punch_time);
    if (anchor === null) return null;
    const context = await buildContext({
      employee_id,
      from: addDays(anchor, -1),
      to: addDays(anchor, 1),
    });
    return attendanceDateForPunch({ ioTime: punch_time, readCutoff: context.readCutoff });
  };

  /**
   * Read and set the employee's Special Break Duration Override (review #7).
   *
   * ONE CURRENT VALUE, NO EFFECTIVE DATE, exactly as the product contract
   * says. `null` clears it, and clearing it is the absence of a value rather
   * than a zero - a zero is the real setting "this employee is charged no
   * break at all", and the two must stay distinguishable.
   *
   * Nothing is recalculated here. Changing somebody's break changes their NRM
   * for every date the engine calculates, which is a large, deliberate act; it
   * is run through the recalculation endpoint by somebody who holds that key,
   * not as a side effect of saving a field.
   */
  const getBreakOverride = async (employee_id) => {
    const row = await attendanceCalculationRepo.getBreakOverride(employee_id);
    return {
      employee_id: Number(employee_id),
      special_break_override_minutes: breakOverrideMinutes(row),
    };
  };

  const setBreakOverride = async ({ employee_id, minutes }) => {
    let value = null;
    if (minutes !== null && minutes !== undefined && minutes !== "") {
      const n = Number(minutes);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw validationError("minutes must be a whole number of minutes, or null to clear it");
      }
      // A break longer than a day is a typo, not a setting.
      if (n > 1439) throw validationError("minutes must be less than a whole day");
      value = n;
    }

    await attendanceCalculationRepo.setBreakOverride(Number(employee_id), value);
    return {
      employee_id: Number(employee_id),
      special_break_override_minutes: value,
      recalculation_required: true,
      msg: "Override saved. Attendance is NOT recalculated automatically - run a recalculation for the range when you are ready.",
    };
  };

  /** The storage shape. JSON columns are stringified once, here. */
  const toStorageRow = (day) => ({
    employee_id: day.employee_id,
    attendance_date: day.attendance_date,
    work_shift_id: day.work_shift_id,
    work_shift_weekly_schedule_id: day.work_shift_weekly_schedule_id,
    work_shift_config_version_id: day.shift_snapshot
      ? day.shift_snapshot.config_version_id || null
      : null,
    shift_snapshot: JSON.stringify(day.shift_snapshot || {}),
    shift_snapshot_hash: day.shift_snapshot_hash || "",
    raw_punch_ids: JSON.stringify(day.raw_punch_ids || []),
    effective_punches: JSON.stringify(day.effective_punches || []),
    punch_count: day.punch_count,
    attendance_day_count: day.attendance_day_count,
    nrm_minutes: day.nrm_minutes,
    span_minutes: day.span_minutes,
    break_allowance_minutes: day.break_allowance_minutes,
    break_allowance_source: day.break_allowance_source,
    actual_gap_minutes: day.actual_gap_minutes,
    break_charged_minutes: day.break_charged_minutes,
    worked_minutes: day.worked_minutes,
    shortage_minutes: day.shortage_minutes,
    late_minutes: day.late_minutes,
    early_exit_minutes: day.early_exit_minutes,
    pre_shift_minutes: day.pre_shift_minutes,
    post_shift_minutes: day.post_shift_minutes,
    raw_ot_minutes: day.raw_ot_minutes,
    ot_offset_minutes: day.ot_offset_minutes,
    pre_shift_ot_minutes: day.pre_shift_ot_minutes,
    post_shift_ot_minutes: day.post_shift_ot_minutes,
    candidate_ot_minutes: day.candidate_ot_minutes,
    approved_ot_minutes: day.approved_ot_minutes,
    ot_rate: day.ot_rate,
    status: day.status,
    is_final: day.is_final ? 1 : 0,
    review_reasons: JSON.stringify(day.review_reasons || []),
    approval_request_id: day.approval_request_id,
    calculation_version: CALCULATION_VERSION,
  });

  /**
   * Calculate a range and store it. Idempotent by the unique key on
   * (employee_id, attendance_date) - see the repository.
   *
   * NOTHING IS QUEUED FOR APPROVAL. A recalculation that finds candidate OT
   * simply reports it; the day shows "OT Available" and the employee raises
   * the OT request themselves, with a reason (`raiseOtRequest` in the
   * regularization usecase). The old automatic OT queue is gone.
   */
  const recalculateRange = async ({ employee_id, from_date, to_date }) => {
    const days = await calculateRange({ employee_id, from_date, to_date });
    const written = await attendanceCalculationRepo.saveCalculations(days.map(toStorageRow));

    return { employee_id, from_date, to_date, days, ...written };
  };

  /**
   * The SINGLE-DATE shift edit.
   *
   * Changes the shift ONE attendance date is calculated under, and nothing
   * else. It does not touch `new_employee.default_work_shift_id`, it appends
   * nothing to `employee_work_shift_assignment` (whose effective-from rows
   * would move every later date as well), and the dates either side resolve
   * exactly as they did. The override table is read by the resolver for
   * exactly this date - see `utils/shiftResolution.js#resolveOverrideForDate`.
   *
   * The day is calculated under the new shift BEFORE anything is written, and
   * the override row and the recalculated day are then stored in ONE
   * transaction, so the shift can never be changed with the stored attendance
   * left showing the old one.
   *
   * IDEMPOTENT. If the date already resolves to the requested shift - a retry
   * of a save that committed, or a no-op edit - no second override row is
   * appended; the date is simply recalculated and stored, which is the same
   * upsert a recalculation performs. Every appended row is the audit line:
   * employee, date, the shift before, the shift after, who, when.
   */
  const setDateShift = async ({ employee_id, attendance_date, work_shift_id, actor_employee_id }) => {
    const employeeId = Number(employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    const workShiftId = Number(work_shift_id);
    if (!Number.isInteger(workShiftId) || workShiftId <= 0) {
      throw validationError("work_shift_id is required and must be a work shift id");
    }

    const loaded = await attendanceCalculationRepo.getWorkShiftWithSchedule(workShiftId);
    const shift = loaded && loaded.config ? loaded.config : null;
    if (!shift) {
      const err = new Error(`No work shift exists for id ${workShiftId}`);
      err.name = "NotFoundError";
      throw err;
    }
    if (shift.active !== undefined && shift.active !== null && Number(shift.active) !== 1) {
      throw validationError(`Work shift ${shift.shift_code || workShiftId} is inactive`);
    }

    // What the date resolves to NOW, through the same resolver the
    // calculation uses (stored overrides included).
    const [before] = await calculateRange({ employee_id: employeeId, from_date: date, to_date: date });
    const previousShiftId = before && before.work_shift_id ? Number(before.work_shift_id) : null;

    // What the date looks like under the new shift. In memory only, so far.
    const [after] = await calculateRange({
      employee_id: employeeId,
      from_date: date,
      to_date: date,
      assume_override: { attendance_date: date, work_shift_id: workShiftId },
    });
    if (!after || !after.shift_snapshot) {
      throw validationError(
        `${date} cannot be calculated under work shift ${shift.shift_code || workShiftId}: it has no schedule row for that weekday`
      );
    }

    const changed = previousShiftId !== workShiftId;
    let stored;
    if (changed) {
      stored = await attendanceCalculationRepo.saveDateShiftOverrideWithCalculation({
        override: {
          employee_id: employeeId,
          attendance_date: date,
          work_shift_id: workShiftId,
          previous_work_shift_id: previousShiftId,
          changed_by: actor_employee_id === undefined ? null : actor_employee_id,
        },
        rows: [toStorageRow(after)],
      });
    } else {
      stored = await attendanceCalculationRepo.saveCalculations([toStorageRow(after)]);
    }

    return {
      employee_id: employeeId,
      attendance_date: date,
      changed,
      previous_work_shift_id: previousShiftId,
      work_shift_id: workShiftId,
      shift_code: shift.shift_code || null,
      shift_name: shift.shift_name || null,
      attendance_date_shift_override_id:
        stored && stored.attendance_date_shift_override_id !== undefined
          ? stored.attendance_date_shift_override_id
          : null,
      day: after,
    };
  };

  /** The active shifts the Edit Shift dropdown offers. */
  const listDateShiftOptions = async () => {
    const rows = attendanceCalculationRepo.listActiveWorkShiftOptions
      ? await attendanceCalculationRepo.listActiveWorkShiftOptions()
      : [];
    return (rows || []).map((r) => ({
      work_shift_id: Number(r.work_shift_id),
      shift_code: r.shift_code,
      shift_name: r.shift_name,
    }));
  };

  /**
   * PAYROLL LOCK, the OT half: close every OT claim in a month that is not
   * finally approved.
   *
   * There is no payroll lock action in this codebase yet. This is the
   * domain entry point the future lock action calls, inside whatever
   * workflow it runs, and it is exposed HERE - on the payroll usecase - so
   * the wiring is one call. The rule it applies (finalized):
   *
   *   OT available but never requested   -> Rejected – Not Requested Before Payroll Lock
   *   OT requested, still pending        -> Rejected – Not Approved Before Payroll Lock
   *   OT already rejected                -> stays rejected
   *   OT finally approved                -> stays approved, paid
   *
   * Afterwards no open OT request exists for the period, and nothing here
   * marks candidate OT payable: only `approved_ot_minutes` from a finally
   * approved request ever reaches payroll. Idempotent - a second run finds
   * nothing to close.
   */
  const closeOtForPayrollLock = async ({ employee_id, year, month, actor_employee_id = null }) => {
    if (!otRequestService || typeof otRequestService.closeOtForPayrollLock !== "function") {
      throw new Error("No OT request service is wired: closeOtForPayrollLock cannot run");
    }
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw validationError("year and month must be integers, month 1-12");
    }
    const pad = (n) => String(n).padStart(2, "0");
    const from = `${y}-${pad(m)}-01`;
    const to = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;

    const days = await calculateRange({ employee_id, from_date: from, to_date: to });
    return otRequestService.closeOtForPayrollLock({
      employee_id: Number(employee_id),
      from_date: from,
      to_date: to,
      days,
      actor_employee_id,
    });
  };

  /**
   * A whole month, calculated and rolled up into the A4 payroll line items.
   *
   * The Monthly Gross comes from the EXISTING effective-dated salary resolver,
   * read as of the LAST day of the period - a revision effective mid-month is
   * a question v2 does not answer, so the month is priced on one rate and the
   * choice is stated here rather than buried.
   */
  const calculateMonth = async ({ employee_id, year, month, persist = false }) => {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw validationError("year and month must be integers, month 1-12");
    }

    const pad = (n) => String(n).padStart(2, "0");
    const from = `${y}-${pad(m)}-01`;
    const to = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;

    const [days, employment, salary] = await Promise.all([
      calculateRange({ employee_id, from_date: from, to_date: to }),
      attendanceCalculationRepo.getEmploymentWindow(employee_id),
      attendanceCalculationRepo.getMonthlyGrossAsOf(employee_id, to),
    ]);

    const payroll = computeMonthlyAttendancePayroll({
      employee_id,
      year: y,
      month: m,
      monthly_gross: salary ? salary.monthly_gross : null,
      days,
      joined_on: employment ? employment.date_of_joining : null,
      ended_on: employment ? employment.resignation_date : null,
    });

    const result = {
      ...payroll,
      salary_record_id: salary ? salary.salary_id : null,
      salary_effective_from: salary ? salary.effective_from : null,
      days,
    };

    if (persist) {
      await attendanceCalculationRepo.saveCalculations(days.map(toStorageRow));
      await attendanceCalculationRepo.saveMonthlyPayroll({
        employee_id,
        period_year: y,
        period_month: m,
        available_from: payroll.available_from,
        available_to: payroll.available_to,
        available_dates: payroll.available_dates,
        notional_offs: payroll.notional_offs,
        base_days: payroll.base_days,
        attendance_days: payroll.attendance_days,
        salary_days: payroll.salary_days,
        extra_days: payroll.extra_days,
        monthly_gross: payroll.monthly_gross,
        daily_rate: payroll.daily_rate,
        salary_day_earnings: payroll.salary_day_earnings,
        extra_day_earnings: payroll.extra_day_earnings,
        shortage_minutes: payroll.shortage_minutes,
        missing_minute_deduction: payroll.missing_minute_deduction,
        approved_ot_minutes: payroll.approved_ot_minutes,
        approved_ot_earnings: payroll.approved_ot_earnings,
        total_attendance_payable: payroll.total_attendance_payable,
        held_dates: JSON.stringify(payroll.held_dates || []),
        is_final: payroll.is_final ? 1 : 0,
        payroll_version: PAYROLL_VERSION,
      });
    }

    return result;
  };

  return {
    MAX_RANGE_DAYS,
    CALC_STATUS,
    RESOLUTION_STATUS,
    dateRange,
    breakOverrideMinutes,
    toStorageRow,
    OT_CLAIM_STATE,
    setOtRequestService,
    closeOtForPayrollLock,
    getBreakOverride,
    setBreakOverride,
    calculateRange,
    calculateProposedDay,
    attendanceDateForPunchTime,
    recalculateRange,
    setDateShift,
    listDateShiftOptions,
    calculateMonth,
  };
};
