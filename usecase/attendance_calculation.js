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
  configVersionForCalculation,
  toShiftDefinition,
  VERSIONED_CONFIG_COLUMNS,
} = require("../utils/shift_config_version");
const {
  PAYROLL_VERSION,
  computeMonthlyAttendancePayroll,
  daysInMonth,
} = require("../utils/attendance_payroll");
const { resolveEffectiveRawPunches } = require("../utils/attendance_effective_punches");
const eligibility = require("../utils/attendance_eligibility");
const { extraBreakMinutes } = require("../utils/employee_extra_break");
const {
  CALCULATION_SOURCE,
  asLivePreview,
  byDate: storedByDate,
  resolveDayForRead,
} = require("../utils/attendance_stored_read");
const { isDayClosed } = require("../utils/attendance_dashboard");
const { propagationScope } = require("../utils/shift_propagation");
const { istToday } = require("../utils/istDate");
const { partitionClosedDays, endOfIstDay } = require("../utils/attendance_persist_guard");
const { payrollLockedError } = require("../utils/attendance_payroll_lock");
const readTiming = require("../utils/attendance_read_timing");

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
 * The window is widened by ONE DAY at the end for DATING, because the cutoff
 * rule can only ever move a punch BACKWARDS onto the previous attendance
 * date: a 00:30 finish on the 15th belongs to the 14th, and no rule anywhere
 * moves a punch forwards. It is also widened by ONE DAY at the start, for the
 * ten-minute duplicate rule only: the first punch of a range is compared with
 * the last KEPT punch before it, which may sit on the previous calendar day.
 * Nothing from that day is calculated or stored - see `buildContext`.
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
/**
 * Whether biometric attendance is expected of this employee.
 *
 * RE-EXPORTED, NOT RE-IMPLEMENTED. The rule - and the two employment bounds
 * that go with it - now live once in `utils/attendance_eligibility.js`, which
 * the bulk run, the single-employee recalculation and the dashboard all read.
 * The copy that used to sit here is what let the three disagree.
 */
const attendanceRequired = eligibility.attendanceRequired;

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
  // Authorised by an approved one-day SHIFT CHANGE. There is no OT request
  // and there must not be one: the approval already happened, under Shift.
  APPROVED_VIA_SHIFT_CHANGE: "APPROVED_VIA_SHIFT_CHANGE",
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
/**
 * WHICH DECISIONS APPROVED THIS DAY'S OT - derived from the components, never
 * stored beside them.
 *
 *   both > 0   MIXED          an approved shift change AND an approved excess
 *   shift > 0  SHIFT_CHANGE
 *   request>0  OT_REQUEST
 *   neither    null
 *
 * A stored enum could disagree with the two figures it describes; a derived
 * one cannot.
 */
function approvedOtSource(day) {
  const shift = Math.max(0, Math.trunc(Number(day && day.shift_authorised_ot_minutes) || 0));
  const request = Math.max(0, Math.trunc(Number(day && day.ot_request_approved_minutes) || 0));
  if (shift > 0 && request > 0) return "MIXED";
  if (shift > 0) return "SHIFT_CHANGE";
  if (request > 0) return "OT_REQUEST";
  return null;
}

function otClaimFor({ day, otRequest, otSettled }) {
  const candidate = Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0));
  /*
   * THE PORTION AN APPROVED SHIFT CHANGE ALREADY AUTHORISES, and what is
   * left for the ordinary request path. On every other date the first is 0
   * and the second is the whole candidate, so nothing below changes for
   * them.
   */
  const authorised = Math.max(0, Math.trunc(Number(day.shift_authorised_ot_minutes) || 0));
  const claimable =
    day.excess_ot_minutes === undefined || day.excess_ot_minutes === null
      ? candidate
      : Math.max(0, Math.trunc(Number(day.excess_ot_minutes) || 0));
  const claim = {
    ot_claim_state: OT_CLAIM_STATE.NONE,
    // What the shift change authorised, what it did not, and which request
    // said so - the three facts the employee's screen and payroll both need.
    ot_shift_authorised_minutes: authorised,
    ot_claimable_minutes: claimable,
    // The OTHER component, and the SOURCE derived from the two. The source is
    // derived and never stored: an enum kept beside the figures it describes
    // is one more thing that can contradict them.
    ot_request_approved_minutes: Math.max(
      0,
      Math.trunc(Number(day.ot_request_approved_minutes) || 0)
    ),
    approved_ot_source: approvedOtSource(day),
    ot_authorising_request_id:
      authorised > 0 ? day.shift_change_request_id || null : null,
    // What became of the CLAIMABLE remainder, which on an ordinary date is
    // the whole day and on an authorised one is only the excess.
    ot_excess_state: OT_CLAIM_STATE.NONE,
    ot_excess_minutes: claimable,
    ot_request_id: otRequest ? otRequest.attendance_approval_request_id : null,
    ot_requested_minutes: otRequest ? Number(otRequest.candidate_ot_minutes || 0) : null,
    ot_reason: otRequest ? otRequest.reason || null : null,
    ot_closure_reason: otRequest ? otRequest.closure_reason || null : null,
    ot_requested_at: otRequest ? otRequest.created_at || null : null,
    ot_decided_at: otRequest ? otRequest.decided_at || null : null,
    // The approver's own words, from the step that rejected. Null unless a
    // human rejected it - a payroll-lock closure has `ot_closure_reason`
    // instead, and an approval has nothing to explain.
    ot_rejection_remarks: otRequest ? otRequest.rejection_remarks || null : null,
  };

  /*
   * THE EXCESS'S OWN STATE, kept apart from the day's headline.
   *
   * An OT request on a shift-authorised date is about the EXCESS - the
   * minutes earned outside the approved shift - and nothing else. Letting its
   * state become the day's would mean a closed or rejected 30-minute excess
   * presenting a day carrying five approved hours as "Closed - Payroll
   * Locked", which is not what happened to those five hours and not what
   * payroll owes. So the request's state is reported as `ot_excess_state`,
   * and the day's own state stays what the shift change made it.
   *
   * On a date with no authorisation the two are the same value, which is
   * every ordinary date and every existing caller.
   */
  if (otRequest) {
    let requestState;
    if (otRequest.status === "PENDING" || (otRequest.status === "APPROVED" && !otSettled)) {
      requestState = OT_CLAIM_STATE.REQUEST_PENDING;
    } else if (otRequest.status === "APPROVED") {
      requestState = OT_CLAIM_STATE.APPROVED;
    } else if (otRequest.closure_reason) {
      requestState = OT_CLAIM_STATE.CLOSED_AT_PAYROLL_LOCK;
    } else {
      requestState = OT_CLAIM_STATE.REJECTED;
    }
    claim.ot_excess_state = requestState;
    claim.ot_claim_state =
      authorised > 0 ? OT_CLAIM_STATE.APPROVED_VIA_SHIFT_CHANGE : requestState;
    return claim;
  }

  /*
   * NOTHING WAS REQUESTED. Three outcomes, in this order:
   *
   *   the shift change authorised OT, and there is claimable excess left
   *     -> APPROVED_VIA_SHIFT_CHANGE, and the screen offers the EXCESS only
   *   the shift change authorised all of it
   *     -> APPROVED_VIA_SHIFT_CHANGE, and nothing is offered at all
   *   no authorisation
   *     -> AVAILABLE, the ordinary path, unchanged
   *
   * A day that is not complete and FINAL offers nothing either way: its
   * overtime is a guess until the missing punch is supplied.
   */
  const settledDay = day.is_final === true && day.status === CALC_STATUS.FINAL;
  if (claimable > 0 && settledDay) claim.ot_excess_state = OT_CLAIM_STATE.AVAILABLE;
  if (authorised > 0 && settledDay) {
    claim.ot_claim_state = OT_CLAIM_STATE.APPROVED_VIA_SHIFT_CHANGE;
  } else if (claimable > 0 && settledDay) {
    claim.ot_claim_state = OT_CLAIM_STATE.AVAILABLE;
  }
  return claim;
}

/** The states an attendance CORRECTION on a day can be in. */
const CORRECTION_STATE = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

/**
 * The attendance correction filed against a day, if any.
 *
 * The MIRROR of `otClaimFor`, for the other request type, and for the same
 * reason: a day already carries whether a correction is holding it open
 * (`regularization_pending`, which is what the Missing Punch / Regularization
 * Pending badge is drawn from), but not WHAT was asked, WHEN, or why it was
 * refused. An employee's own request list needs those three, and reading
 * them off the request row the range already loaded costs no extra query.
 *
 * IT DECIDES NO ATTENDANCE STATE. The day's status is the engine's, exactly
 * as before; these fields describe the REQUEST beside it and nothing else.
 * A legacy REGULARIZATION_WITH_OT request is a correction here, as it is
 * everywhere else in this file.
 */
function correctionClaimFor({ approval }) {
  const claim = {
    correction_request_id: approval ? approval.attendance_approval_request_id : null,
    correction_state: CORRECTION_STATE.NONE,
    correction_reason: approval ? approval.reason || null : null,
    correction_requested_at: approval ? approval.created_at || null : null,
    correction_decided_at: approval ? approval.decided_at || null : null,
    correction_rejection_remarks: approval ? approval.rejection_remarks || null : null,
  };
  if (!approval) return claim;
  if (approval.status === "PENDING") claim.correction_state = CORRECTION_STATE.PENDING;
  else if (approval.status === "APPROVED") claim.correction_state = CORRECTION_STATE.APPROVED;
  else claim.correction_state = CORRECTION_STATE.REJECTED;
  return claim;
}

/** The states a ONE-DAY SHIFT CHANGE request on a day can be in. */
const SHIFT_CHANGE_STATE = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

/**
 * The one-day shift change request filed against a day, if any.
 *
 * The third mirror of `otClaimFor`, for the third request type, and it
 * DECIDES NOTHING. A pending shift request does not hold the date open, does
 * not mark it REGULARIZATION_PENDING and does not change which shift the day
 * is calculated under - only a final approval does that, and it does it by
 * writing an `attendance_date_shift_override` row that the resolver reads
 * like any other. These fields describe the REQUEST beside the day so the
 * employee's own screen can say what they asked for and what came of it.
 */
function shiftChangeClaimFor({ shiftRequest }) {
  const claim = {
    shift_change_request_id: shiftRequest ? shiftRequest.attendance_approval_request_id : null,
    shift_change_state: SHIFT_CHANGE_STATE.NONE,
    shift_change_requested_work_shift_id: shiftRequest
      ? shiftRequest.requested_work_shift_id || null
      : null,
    shift_change_reason: shiftRequest ? shiftRequest.reason || null : null,
    shift_change_requested_at: shiftRequest ? shiftRequest.created_at || null : null,
    shift_change_decided_at: shiftRequest ? shiftRequest.decided_at || null : null,
    shift_change_rejection_remarks: shiftRequest ? shiftRequest.rejection_remarks || null : null,
  };
  if (!shiftRequest) return claim;
  if (shiftRequest.status === "PENDING") claim.shift_change_state = SHIFT_CHANGE_STATE.PENDING;
  else if (shiftRequest.status === "APPROVED") claim.shift_change_state = SHIFT_CHANGE_STATE.APPROVED;
  else claim.shift_change_state = SHIFT_CHANGE_STATE.REJECTED;
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
  /**
   * TODAY, injectable.
   *
   * The propagation's candidate dates end before today - today's attendance
   * day is never closed, and only closed dates are persisted - and a test that had to agree with the wall clock would start failing on
   * its own one day. `options.today` may be a `YYYY-MM-DD` string or a
   * function returning one; production passes neither and gets the IST
   * business date.
   */
  const todayIs = (override) => {
    const explicit = toDateOnly(override);
    if (explicit !== null) return explicit;
    const configured = typeof options.today === "function" ? options.today() : options.today;
    return toDateOnly(configured) || istToday();
  };

  /**
   * NOW, injectable - the instant the closed-date guard is evaluated at.
   *
   * An explicit instant wins; then `options.now` (an epoch, a Date, or a
   * function returning either); then, for a caller that pinned only a business
   * DATE (`today` here or `options.today`), the last minute of that IST day -
   * so a pinned "today" is still open and everything before it whose cutoff
   * has passed is closed. Production passes none of them and gets the clock.
   */
  const nowIs = (override = null, todayOverride = null) => {
    const asInstant = (value) =>
      value instanceof Date ? value.getTime() : typeof value === "number" && Number.isFinite(value) ? value : null;
    const explicit = asInstant(override);
    if (explicit !== null) return explicit;
    const configured = asInstant(typeof options.now === "function" ? options.now() : options.now);
    if (configured !== null) return configured;
    const pinnedDate =
      toDateOnly(todayOverride) ||
      toDateOnly(typeof options.today === "function" ? options.today() : options.today);
    if (pinnedDate !== null) return endOfIstDay(pinnedDate);
    return Date.now();
  };

  /**
   * IS THIS CALCULATED DAY'S ATTENDANCE DAY CLOSED? The one question every
   * writer of `attendance_day_calculation` asks before it stores a day.
   *
   * `day` is a day `calculateRange` returned - it carries the shift snapshot
   * it was calculated under, which is what decides the cutoff. The answer is
   * `utils/attendance_persist_guard.js`'s, at this usecase's clock (or the
   * instant / pinned business date the caller passes), so a regularization,
   * an approval and a shift edit decide "open" exactly as a recalculation
   * does. `{ closed, reason, closes_at }`; reason/closes_at are null when
   * closed.
   */
  const attendanceDayState = (day, { now = null, today = null } = {}) => {
    const { closed, skipped } = partitionClosedDays({ days: day ? [day] : [], now: nowIs(now, today) });
    if (closed.length === 1) return { closed: true, reason: null, closes_at: null };
    const entry = skipped[0] || { reason: "DAY_OPEN", closes_at: null };
    return { closed: false, reason: entry.reason, closes_at: entry.closes_at };
  };

  let otRequestService = options.ot_request_service || null;
  const setOtRequestService = (service) => {
    otRequestService = service || null;
  };

  /**
   * The punch RE-DERIVATION collaborator, injected for the same reason.
   *
   * It lives in `usecase/attendance_import.js`. Recalculate has to reach it
   * because the two halves of "this date's shift" live in two tables and
   * only one of them was ever recomputed: `attendance_calculation` resolves
   * the shift from dated history on every run, while
   * `biomax_punch_derived.derivation_status` is stamped once at ingest and
   * was never revisited. An employee given a shift after their punches
   * arrived therefore calculated correctly and still read "No Shift" in the
   * Punch Audit, with no action anywhere that could clear it.
   *
   * Recalculate now re-derives the range's undatable punches FIRST and then
   * calculates, so both halves agree afterwards. Optional: a caller that
   * wires no service simply recalculates as before.
   */
  let punchRedriveService = options.punch_redrive_service || null;
  const setPunchRedriveService = (service) => {
    punchRedriveService = service || null;
  };

  /**
   * Re-derive the undatable punches of these employees over this range, and
   * never let that fail a recalculation: a punch that cannot be re-derived
   * is a cause that has not been fixed yet, not a reason to refuse to
   * recalculate the dates that can be.
   */
  const redrivePunches = async ({ employee_ids, from, to }) => {
    if (!punchRedriveService || typeof punchRedriveService.redriveUndated !== "function") return null;
    try {
      return await punchRedriveService.redriveUndated({
        employeeIds: employee_ids,
        // A punch on the morning after `to` can belong to `to`, and one on
        // the evening before `from` can belong to `from` - the same slack
        // the calculation reads punches over.
        from: addDays(from, -1),
        to: addDays(to, 1),
      });
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  };

  /**
   * Read every shift a history references, once - both its LIVE definition and
   * its effective-dated configuration VERSIONS.
   *
   * A month typically touches one shift; a month that spans a roster change
   * touches two. Either way each one is fetched once and the resolver reads
   * from memory, rather than a query per date.
   */
  /**
   * A version document written before a column was versioned lacks the key
   * altogether. Such a column was not "0 then" - it was never recorded - so
   * the live row supplies it. Only ABSENT keys are filled; a value the
   * version does carry, including 0, is what that date calculates under.
   */
  const withLiveDefaults = (definition, live) => {
    // `live` is the repository's `{ config, schedule }` pair.
    const liveConfig = live && live.config ? live.config : null;
    if (!definition || !liveConfig) return definition;
    const config = { ...definition.config };
    VERSIONED_CONFIG_COLUMNS.forEach((column) => {
      if (config[column] === undefined && liveConfig[column] !== undefined) {
        config[column] = liveConfig[column];
      }
    });
    return { ...definition, config };
  };

  const loadShiftCache = async (assignments) => {
    const ids = [...new Set((assignments || []).map((a) => Number(a.work_shift_id)))];
    const cache = new Map();

    // BULK: three reads for every shift the range references, not three per
    // shift one after another. The rows are grouped back into exactly the
    // `{ live: { config, schedule }, versions }` shape the per-shift reads
    // below produce, so nothing downstream can tell which path ran.
    if (
      ids.length > 0 &&
      typeof attendanceCalculationRepo.getWorkShiftConfigsByIds === "function" &&
      typeof attendanceCalculationRepo.getWorkShiftSchedulesByIds === "function" &&
      typeof attendanceCalculationRepo.getWorkShiftConfigVersionsByIds === "function"
    ) {
      const [configs, schedules, versionRows] = await Promise.all([
        attendanceCalculationRepo.getWorkShiftConfigsByIds(ids),
        attendanceCalculationRepo.getWorkShiftSchedulesByIds(ids),
        attendanceCalculationRepo.getWorkShiftConfigVersionsByIds(ids),
      ]);
      const byShift = (rows) => {
        const map = new Map();
        (rows || []).forEach((row) => {
          const id = Number(row.work_shift_id);
          if (!map.has(id)) map.set(id, []);
          map.get(id).push(row);
        });
        return map;
      };
      const configById = byShift(configs);
      const scheduleById = byShift(schedules);
      const versionsById = byShift(versionRows);
      for (const id of ids) {
        const config = (configById.get(id) || [])[0] || null;
        const live = config ? { config, schedule: scheduleById.get(id) || [] } : null;
        const versions = versionsById.get(id) || [];
        if (live || versions.length > 0) cache.set(id, { live, versions });
      }
      return cache;
    }

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
  const buildContext = async ({
    employee_id,
    from,
    to,
    assume_override = null,
    assume_io_times = null,
    exclude_request_id = null,
  }) => {
    // ONE day of slack at the END for DATING - see the file header. A punch on
    // the morning after `to` can belong to `to`; a punch before `from` can
    // never belong to `from`.
    //
    // ONE day of slack at the START for the DUPLICATE RULE only. Whether the
    // first punch of `from` is a duplicate depends on the last KEPT punch
    // before it - 23:58 on the previous calendar day and 00:04 are six
    // minutes apart - so the effective stream is resolved over the day
    // before as well. Nothing from that day is calculated or stored here:
    // a punch that dates to before `from` is dropped by the grouping below
    // exactly as it always was. The duplicate chain resets at any gap longer
    // than ten minutes, so one day is far more neighbourhood than it needs.
    const punchWindowFrom = addDays(from, -1);
    const punchWindowTo = addDays(to, 1);

    // Each read is named for the temporary read timing (a no-op outside a
    // timed request). They run in parallel, so their durations overlap.
    const t = readTiming.phase;
    const [assignments, fetchedRawPunches, regularized, employee, approvals, storedOverrides] =
      await Promise.all([
        t("shift_assignment_lookup", () => attendanceCalculationRepo.getShiftAssignmentHistory(employee_id)),
        t("raw_punch_lookup", () =>
          attendanceCalculationRepo.getRawPunchesByCalendarWindow(employee_id, punchWindowFrom, punchWindowTo)
        ),
        t("regularized_punch_lookup", () =>
          attendanceCalculationRepo.getApprovedRegularizedPunches(employee_id, from, to)
        ),
        t("employee_settings_lookup", () => attendanceCalculationRepo.getBreakOverride(employee_id)),
        // ONE read answers corrections, OT requests and shift-change requests.
        t("correction_ot_request_lookup", () =>
          attendanceCalculationRepo.getApprovalStateByDate(employee_id, from, to)
        ),
        // Single-date overrides. The cutoff rule can date a punch one day back,
        // so the day AFTER `to` is read as well: dating that punch needs the
        // shift that applied on its own date.
        t("shift_override_lookup", () =>
          attendanceCalculationRepo.getDateShiftOverrides
            ? attendanceCalculationRepo.getDateShiftOverrides(employee_id, from, punchWindowTo)
            : []
        ),
      ]);

    // A DEVICE TIME CORRECTION being applied or reverted, in memory only:
    // `punch_id -> io_time` replaces the effective time of exactly those raw
    // punches, so the day can be calculated as it WILL read once the
    // correction commits - inside the transaction that records it. Every
    // other punch is read exactly as stored.
    const assumedTimes =
      assume_io_times instanceof Map
        ? assume_io_times
        : assume_io_times
          ? new Map(Object.entries(assume_io_times))
          : null;
    const rawPunches =
      assumedTimes && assumedTimes.size > 0
        ? (fetchedRawPunches || []).map((punch) =>
            assumedTimes.has(String(punch.punch_id))
              ? { ...punch, io_time: assumedTimes.get(String(punch.punch_id)) }
              : punch
          )
        : fetchedRawPunches;

    // An override that is being SAVED joins the stored ones in memory only, so
    // the day can be calculated under it inside the transaction that records
    // it. It carries the greatest id by construction, so it wins the date.
    // A SHIFT_CHANGE approval being REVOKED: its override is withdrawn with
    // it, here, before any punch is dated - the shift decides the cutoff, so
    // the day without the approval must be dated without it too. Any other
    // override on the date (a management edit, an earlier row) stays.
    const withdrawnRequest =
      exclude_request_id === null || exclude_request_id === undefined ? null : Number(exclude_request_id);
    const overrides = (storedOverrides || []).filter(
      (row) => withdrawnRequest === null || Number(row && row.attendance_approval_request_id) !== withdrawnRequest
    );
    if (assume_override) {
      overrides.push({
        attendance_date_shift_override_id: Number.MAX_SAFE_INTEGER,
        employee_id,
        attendance_date: toDateOnly(assume_override.attendance_date),
        work_shift_id: Number(assume_override.work_shift_id),
        // A SHIFT_CHANGE being finally approved in the caller's own
        // transaction: the override row and the approved request do not exist
        // to be joined yet, so the decision states the authorisation it is
        // about to write. Anything else assumed - a management date-shift
        // edit - authorises nothing, exactly as its stored row would not.
        shift_change_approved: assume_override.shift_change_approved === true ? 1 : 0,
        attendance_approval_request_id:
          assume_override.attendance_approval_request_id === undefined
            ? null
            : assume_override.attendance_approval_request_id,
      });
    }

    const shiftCache = await readTiming.phase("shift_definition_lookup", () =>
      loadShiftCache([...(assignments || []), ...overrides])
    );

    // (shift, date) -> the configuration VERSION in force then. Memoized
    // because a month resolves the same pair thirty times.
    const definitions = new Map();
    const definitionFor = (workShiftId, date) => {
      const key = `${workShiftId}|${date}`;
      if (definitions.has(key)) return definitions.get(key);

      const loaded = shiftCache.get(Number(workShiftId));
      let definition = null;
      if (loaded) {
        // THE CURRENT CONFIGURATION, for every date this engine calculates.
        // A calculation only ever happens for a date payroll has not settled
        // - a locked month is refused at the write and READ from its stored
        // row - so there is no date here whose rules are supposed to be
        // historical. See
        // `utils/shift_config_version.js#configVersionForCalculation`.
        const versionRow = configVersionForCalculation(loaded.versions);
        definition = versionRow
          ? withLiveDefaults(toShiftDefinition(versionRow, workShiftId), loaded.live)
          : // A shift with no version history at all: the live tables answer
            // and say so.
            loaded.live
            ? {
                ...loaded.live,
                config_version_id: null,
                config_version_hash: null,
                config_effective_from: null,
                from_live: true,
              }
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

    /**
     * The PERMANENT shift for a date - the dated assignment history ALONE,
     * with the single-date overrides deliberately not passed.
     *
     * This is what the day's pay entitlement is measured against. On an
     * ordinary date it resolves to the very same shift as `resolutionFor`,
     * and the engine notices that the two ids match and changes nothing. On a
     * date carrying an approved one-day override the two differ, and that
     * difference is the whole point: the temporary shift decides the day's
     * rules, the permanent one decides its regular time, its overtime split
     * and its shortage.
     */
    const baseResolutions = new Map();
    const baseResolutionFor = (date) => {
      if (baseResolutions.has(date)) return baseResolutions.get(date);
      const resolution = resolveShiftForDate({
        assignments,
        overrides: [],
        attendanceDate: date,
        readSchedule,
        readShiftConfig,
      });
      baseResolutions.set(date, resolution);
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
      // The employee's Extra Break Hours, already in whole minutes. Read from
      // the SAME employee row as the override, on the same one current-value
      // rule, so the two cannot disagree about which employee they describe.
      extra_break_minutes: extraBreakMinutes(employee),
      attendance_required: attendanceRequired(employee),
      resolutionFor,
      baseResolutionFor,
      readCutoff,
      shiftNameFor,
    };
  };

  /** `biomax_punch.ingest_source` -> the engine's source. Only the import is not a device. */
  const rawSource = (ingestSource) =>
    ingestSource === "DIGISME_IMPORT" || ingestSource === "IMPORT"
      ? PUNCH_SOURCE.IMPORT
      : PUNCH_SOURCE.BIOMAX;

  /**
   * THE EFFECTIVE RAW STREAM, then the grouping by attendance date.
   *
   * This is the one implementation point of the two raw-punch exclusions.
   * Every path that calculates - the preview, a single-date recalculation,
   * the bulk run, the approval's assumed day, the proposed-punch pricing -
   * comes through `buildContext` and then here, so the rule holds the same
   * way for a historical date, a freshly imported punch and tonight's
   * device punch. In this order:
   *
   *   1. raw BIOMAX + IMPORT punches, one chronological stream by the
   *      absolute punch instant (the calendar date takes no part, so a
   *      midnight crossing does not reset anything);
   *   2. manually VOIDED punches are removed;
   *   3. a punch ten minutes or less after the LAST KEPT punch is IGNORED
   *      as a duplicate (`utils/attendance_effective_punches.js`);
   *   4. the kept punches are re-dated to their attendance day and grouped;
   *   5. the APPROVED regularized punches join per date in `calculateRange`,
   *      untouched by steps 2 and 3, and the engine pairs positionally.
   *
   * The excluded punches are grouped by the same derived date and handed to
   * the engine as `excluded_punches`, so the day can show them; they count
   * for nothing. Anything that lands outside the requested range is dropped
   * either way - including the extra day read for step 3.
   */
  const groupRawPunchesByAttendanceDate = ({ rawPunches, readCutoff, from, to }) => {
    const shaped = (rawPunches || []).map((punch) => ({
      punch_id: punch.punch_id,
      source: rawSource(punch.ingest_source),
      dev_id: punch.dev_id,
      io_time: punch.io_time,
      // What ingest thought, kept beside what the engine derived, so a
      // disagreement is visible instead of silent.
      ingest_attendance_date: punch.ingest_attendance_date || null,
      attendance_punch_void_id: punch.attendance_punch_void_id || null,
      void_reason: punch.void_reason === undefined ? null : punch.void_reason,
      voided_by_employee_id:
        punch.voided_by_employee_id === undefined ? null : punch.voided_by_employee_id,
      voided_at: punch.voided_at === undefined ? null : punch.voided_at,
    }));

    const { all } = resolveEffectiveRawPunches(shaped);

    const byDate = new Map();
    const excludedByDate = new Map();
    all.forEach((punch) => {
      const derived = attendanceDateForPunch({ ioTime: punch.io_time, readCutoff });
      if (derived === null || derived < from || derived > to) return;
      const { attendance_punch_void_id, void_reason, voided_by_employee_id, voided_at, ...rest } = punch;
      const row = { ...rest, attendance_date: derived };
      const target = punch.effective_status === "USED" ? byDate : excludedByDate;
      if (!target.has(derived)) target.set(derived, []);
      target.get(derived).push(row);
    });
    return { byDate, excludedByDate };
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
  /**
   * Calculate a range with the engine. THE CALCULATION PATH, not the read
   * path: everything here is computed from punches, dated shift history and
   * the employee's CURRENT settings, and every day it returns is therefore a
   * LIVE_PREVIEW. `readRange` below is what a screen asks; this is what a
   * recalculation stores and what a preview shows.
   */
  const calculateRange = async ({
    employee_id,
    from_date,
    to_date,
    assume = null,
    assume_override = null,
    // `punch_id -> effective io_time` for a device time correction being
    // applied or reverted - see `buildContext`. Absent everywhere else.
    assume_io_times = null,
    // THE DAY AS IF ONE REQUEST DID NOT EXIST. An administrator's revocation
    // CANCELS a request inside the transaction that asks for this day, so the
    // committed row must already be the day without it: no approval state
    // from it, no regularized punch of it and - for an approved SHIFT_CHANGE -
    // no override of it. Only that one request is withdrawn - any other
    // request or override on the date is read as stored.
    exclude_request_id = null,
    // THE READ OVERLAY, supplied only by `readRange`. A map of
    // `YYYY-MM-DD` -> stored row: where one exists for a date that has
    // CLOSED, that row is what comes back and the engine's answer for that
    // date is discarded. Absent (the default) nothing is overlaid, which is
    // what every calculation and every preview wants.
    stored_days = null,
    // The same overlay, as a function returning a promise of it. `readRange`
    // passes this instead of `stored_days` so the stored rows are read
    // ALONGSIDE the context rather than before it - one database round trip
    // fewer on the screen's critical path. What comes back is identical.
    stored_days_loader = null,
    now = Date.now(),
  }) => {
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }
    if (from > to) throw validationError("from_date must not be after to_date");

    const dates = readTiming.phaseSync("date_generation", () => dateRange(from, to));
    if (dates.length > MAX_RANGE_DAYS) {
      throw validationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
    }

    const [context, loadedStoredDays] = await readTiming.phase("db_reads_wall", () =>
      Promise.all([
        buildContext({ employee_id, from, to, assume_override, assume_io_times, exclude_request_id }),
        typeof stored_days_loader === "function"
          ? readTiming.phase("stored_calculation_lookup", () => stored_days_loader())
          : stored_days,
      ])
    );
    if (exclude_request_id !== null && exclude_request_id !== undefined) {
      const withdrawn = Number(exclude_request_id);
      const kept = (row) => Number(row && row.attendance_approval_request_id) !== withdrawn;
      context.approvals = (context.approvals || []).filter(kept);
      context.regularized = (context.regularized || []).filter(kept);
    }
    const { byDate: rawByDate, excludedByDate } = groupRawPunchesByAttendanceDate({
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

    // THREE SLOTS PER DATE, one per kind of request. `regularization` is the
    // attendance correction (a REGULARIZATION request, or a legacy
    // REGULARIZATION_WITH_OT one); `ot` is the employee's OT claim; `shift`
    // is a one-day shift change request. Among several rows of one kind the
    // newest wins, which is the one that is not CANCELLED.
    //
    // THE THIRD SLOT IS NOT COSMETIC. This used to be "OT, or else a
    // correction", and a SHIFT_CHANGE request therefore fell into the
    // correction slot - which would have held the date out of payroll as
    // REGULARIZATION_PENDING while a shift request sat in the queue, and
    // reported that request to the employee as a correction, with its reason,
    // on the Corrections tab. A shift request is neither: it proposes no
    // punch, it corrects nothing, and while it is pending the date is an
    // ordinary date calculated under the employee's ordinary shift.
    const approvalByDate = new Map();
    (context.approvals || []).forEach((row) => {
      const date = toDateOnly(row.attendance_date);
      if (!approvalByDate.has(date)) {
        approvalByDate.set(date, { regularization: null, ot: null, shift: null });
      }
      const slot = approvalByDate.get(date);
      if (row.request_type === "OT") slot.ot = row;
      else if (row.request_type === "SHIFT_CHANGE") slot.shift = row;
      else slot.regularization = row;
    });

    const assumedDate = assume ? toDateOnly(assume.attendance_date) : null;
    const storedDays = loadedStoredDays || null;

    // "live_calculation" in the read timing: the engine over every date, plus
    // the stored-or-live decision per date. No database access happens here.
    return readTiming.phaseSync("live_calculation", () => dates.map((date) => {
      const resolution = context.resolutionFor(date);

      const slots = approvalByDate.get(date) || { regularization: null, ot: null, shift: null };
      let approval = slots.regularization;
      let otRequest = slots.ot;
      let shiftRequest = slots.shift;
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
        } else if (assumed.request_type === "SHIFT_CHANGE") {
          // A shift decision being committed in this very transaction. The
          // shift it makes effective reaches the calculation through
          // `assume_override`, which is what actually changes the day; this
          // slot only carries the REQUEST's state for the read.
          shiftRequest = assumed;
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
        excluded_punches: excludedByDate.get(date) || [],
        regularized_punches: regularizedPunches.map((p) => ({
          punch_id: p.punch_id === undefined ? null : p.punch_id,
          source: PUNCH_SOURCE.REGULARIZED,
          io_time: p.io_time,
        })),
        break_override_minutes: context.break_override_minutes,
        extra_break_minutes: context.extra_break_minutes,
        approved_ot_minutes: approvedOt,
        regularization_pending: stillOpen,
        attendance_required: context.attendance_required,
        // The PAYROLL BASE. Ignored by the engine whenever it names the same
        // shift the day was calculated under, which is every ordinary date.
        base_shift: context.baseResolutionFor(date).snapshot,
        // Does an APPROVED employee shift request stand behind this date's
        // shift? If so the overtime that shift produces is already
        // authorised and needs no second request.
        shift_authorised: !!(resolution.assignment && resolution.assignment.shift_change_approved),
        shift_change_request_id:
          resolution.assignment && resolution.assignment.shift_change_approved
            ? resolution.assignment.attendance_approval_request_id || null
            : null,
      });

      // STORED HISTORY WINS, when there is any and the date has closed. The
      // decision is `utils/attendance_stored_read.js`'s, so the dashboard
      // cannot answer it differently, and the OT claim below is computed from
      // the day actually being RETURNED - a claim derived from a figure the
      // caller is not being shown would be its own inconsistency.
      const storedRow = storedDays ? storedDays.get(date) || null : null;
      const day = resolveDayForRead({
        live: calculated,
        stored: storedRow,
        day_closed: storedRow
          ? isDayClosed({ attendance_date: date, snapshot: resolution.snapshot, now })
          : false,
      });

      return {
        ...day,
        ...otClaimFor({ day, otRequest, otSettled }),
        ...correctionClaimFor({ approval }),
        ...shiftChangeClaimFor({ shiftRequest }),
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
    }));
  };

  /**
   * WHAT A SCREEN ASKS FOR: the stored history where there is any, the
   * engine's answer where there is not.
   *
   * THE ONE READ PATH. `/attendance/calculated`, `/attendance/me`, the
   * monthly read and the Attendance Dashboard all resolve a date the same
   * way, through `utils/attendance_stored_read.js`, so two screens cannot
   * give two answers for one historical date.
   *
   * IT WRITES NOTHING. Reading a date never stores it, never repairs it and
   * never queues anything: a date that has drifted is corrected by somebody
   * running Recalculate, deliberately, which is also the only thing that can
   * replace a stored row.
   */
  const readRange = async ({ employee_id, from_date, to_date, now = Date.now() }) => {
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }
    if (from > to) throw validationError("from_date must not be after to_date");

    // Read alongside the calculation context, not before it: the same rows,
    // one round trip fewer in sequence.
    const loadStored = async () =>
      storedByDate(
        attendanceCalculationRepo.listCalculations
          ? await attendanceCalculationRepo.listCalculations({
              employee_id: Number(employee_id),
              from_date: from,
              to_date: to,
            })
          : []
      );

    return calculateRange({
      employee_id,
      from_date: from,
      to_date: to,
      stored_days_loader: loadStored,
      now,
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
   * `attendanceDateForPunchTime` for SEVERAL times of one employee near one
   * date, reading the dated shift history once. Same rule, same cutoff: the
   * device time correction dates every punch's original and corrected time
   * with it. A time that cannot be dated (no shift) comes back null.
   */
  const attendanceDatesForPunchTimes = async ({ employee_id, near_date, punch_times }) => {
    const anchor = toDateOnly(near_date);
    if (anchor === null) return (punch_times || []).map(() => null);
    const context = await buildContext({
      employee_id,
      from: addDays(anchor, -1),
      to: addDays(anchor, 1),
    });
    return (punch_times || []).map((time) =>
      attendanceDateForPunch({ ioTime: time, readCutoff: context.readCutoff })
    );
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
    base_nrm_minutes: day.base_nrm_minutes === undefined ? day.nrm_minutes : day.base_nrm_minutes,
    base_work_shift_id: day.base_work_shift_id === undefined ? null : day.base_work_shift_id,
    span_minutes: day.span_minutes,
    break_allowance_minutes: day.break_allowance_minutes,
    break_allowance_source: day.break_allowance_source,
    // PROVENANCE: the two employee settings AS APPLIED on this date, which
    // the total above cannot be split back into once both are in play.
    break_override_minutes_applied:
      day.break_override_minutes_applied === undefined ? null : day.break_override_minutes_applied,
    extra_break_minutes_applied:
      day.extra_break_minutes_applied === undefined ? 0 : day.extra_break_minutes_applied,
    actual_gap_minutes: day.actual_gap_minutes,
    break_charged_minutes: day.break_charged_minutes,
    worked_minutes: day.worked_minutes,
    regular_minutes:
      day.regular_minutes === undefined
        ? Math.min(day.worked_minutes || 0, day.nrm_minutes || 0)
        : day.regular_minutes,
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
    /*
     * WHY this day has approved OT, as TWO components on the row payroll
     * reads - so a payslip investigation can decompose the total exactly
     * ("5h00 by shift request #101, 0h30 by OT request #202") without
     * re-resolving the override, and without guessing from
     * `approval_request_id`, whose meaning is broader than OT and which on
     * a corrected day names the CORRECTION.
     *
     * Each id is stored only when its own component actually approved
     * minutes, so an id on the row always means "this decision approved
     * these minutes" and never merely "this request exists".
     */
    shift_authorised_ot_minutes:
      day.shift_authorised_ot_minutes === undefined ? 0 : day.shift_authorised_ot_minutes,
    shift_authorising_request_id:
      Number(day.shift_authorised_ot_minutes) > 0 ? day.shift_change_request_id || null : null,
    ot_request_approved_minutes:
      day.ot_request_approved_minutes === undefined ? 0 : day.ot_request_approved_minutes,
    ot_request_id: Number(day.ot_request_approved_minutes) > 0 ? day.ot_request_id || null : null,
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
   * THE ELIGIBILITY RULE IS APPLIED HERE, ONCE, FOR EVERY PATH. This is the
   * only function that stores attendance for a range, and both recalculation
   * entry points - the single-employee endpoint and every employee of a bulk
   * run - go through it, so `utils/attendance_eligibility.js` is consulted
   * exactly once per employee and cannot be applied differently by one caller
   * than another. Dates outside the employee's employment are not calculated,
   * and an employee with `attendance_required = 0` is not calculated at all.
   *
   * AND THE RANGE IS RECONCILED, not merely filtered. Excluding a date from
   * the calculation leaves whatever was stored for it last time exactly where
   * it was, which is how an exempted, resigned or corrected employee kept a
   * screenful of calculated days they are not entitled to. So the rows the
   * requested window holds for now-ineligible dates are DELETED in the same
   * transaction that writes the eligible ones.
   *
   * THE DATES TO DELETE ARE COMPUTED FROM THE RULE, NOT FROM THE CALCULATION.
   * `ineligibleDatesIn` walks the requested window and returns the dates the
   * shared rule excludes - and that list, and only that list, is what the
   * repository deletes. Deriving it instead from "the dates the engine did
   * not return" would make a missing shift assignment, an unreadable shift
   * configuration, a short punch read, an incomplete batch or a thrown
   * exception delete somebody's attendance history, because all of those also
   * produce no row. A date that failed to calculate keeps what it had:
   * stale-but-recalculable is recoverable, deleted is not.
   *
   * Nothing outside the requested employee and window is touched, and no raw
   * punch is touched by anything here.
   *
   * NOTHING IS QUEUED FOR APPROVAL. A recalculation that finds candidate OT
   * simply reports it; the day shows "OT Available" and the employee raises
   * the OT request themselves, with a reason (`raiseOtRequest` in the
   * regularization usecase). The old automatic OT queue is gone.
   *
   * ONLY CLOSED DATES ARE PERSISTED (`utils/attendance_persist_guard.js`).
   * The requested window may run into today or the future - a month-to-date
   * run is the ordinary request - but a date whose attendance day has not
   * closed under its own shift snapshot and cutoff is calculated, NOT stored,
   * and reported in `skipped_open_dates` with the reason and the moment it
   * closes. `days` holds the persisted days only, so nothing reports a date as
   * processed that was not. An open date stays readable as LIVE_PREVIEW, and
   * any row it already has is left exactly as it was: skipping is not deleting.
   * Every path through here obeys it - the single endpoint, each employee of
   * a bulk run, Work Shift propagation, an assignment change, a punch void.
   */
  const recalculateRange = async ({ employee_id, from_date, to_date, now = null }) => {
    const employeeId = Number(employee_id);
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }
    if (from > to) throw validationError("from_date must not be after to_date");
    if (dateRange(from, to).length > MAX_RANGE_DAYS) {
      throw validationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
    }

    // The employment facts and the exemption switch, read FIRST and once. A
    // caller that named an employee who does not exist is a validation error
    // at the bulk entry point; here an absent row simply carries no bounds,
    // which is the same unbounded treatment an absent joining date has
    // always had.
    const employment = attendanceCalculationRepo.getEmploymentWindow
      ? await attendanceCalculationRepo.getEmploymentWindow(employeeId)
      : null;
    const window = eligibility.eligibleWindow(employment, from, to);

    // Re-deriving punches is work done FOR a calculation, so it happens only
    // when there is one to do. An employee exempt from attendance, or a
    // window entirely outside their employment, gets the reconciliation below
    // and nothing else - and re-deriving would in any case not change the
    // outcome for a date nobody is going to calculate.
    // See `setPunchRedriveService` for why Recalculate owns this.
    const redrive = window
      ? await redrivePunches({
          employee_ids: [employeeId],
          from: window.from,
          to: window.to,
        })
      : null;

    const calculated = window
      ? await calculateRange({
          employee_id: employeeId,
          from_date: window.from,
          to_date: window.to,
        })
      : [];

    // THE CLOSED-DATE GUARD. Decided per date from the snapshot the day was
    // calculated under, at one instant for the whole window.
    const { closed: days, skipped: skippedOpenDates } = partitionClosedDays({
      days: calculated,
      now: nowIs(now),
    });

    // THE PAYROLL LOCK STILL REFUSES WHAT IT REFUSED BEFORE. A date the
    // guard holds back never reaches the transactional gate, so a request
    // whose only dates in a locked month are open ones would otherwise
    // succeed quietly where it used to be refused. Asked here for exactly
    // those dates; the `FOR UPDATE` gate remains the rule for every row that
    // IS written.
    if (skippedOpenDates.length > 0 && attendanceCalculationRepo.findPayrollLockedPeriods) {
      const locked = await attendanceCalculationRepo.findPayrollLockedPeriods(
        skippedOpenDates.map((entry) => ({ employee_id: employeeId, attendance_date: entry.attendance_date }))
      );
      if (locked && locked.length > 0) throw payrollLockedError(locked);
    }

    // The dates the shared rule excludes, over the REQUESTED window - stated
    // positively, independently of whatever the engine did or did not return.
    const ineligibleDates = eligibility.ineligibleDatesIn(employment, from, to);

    const stored = await attendanceCalculationRepo.saveCalculationsWithReconciliation({
      employee_id: employeeId,
      from_date: from,
      to_date: to,
      rows: days.map(toStorageRow),
      ineligible_dates: ineligibleDates,
    });

    return {
      employee_id: employeeId,
      from_date: from,
      to_date: to,
      days,
      // Eligible dates that were calculated but NOT persisted because their
      // attendance day has not closed. Each still reads as LIVE_PREVIEW.
      skipped_open_dates: skippedOpenDates,
      // What the eligibility rule did to the requested window, stated rather
      // than silently applied: an empty result is otherwise indistinguishable
      // from a run that found nothing.
      eligible_from: window ? window.from : null,
      eligible_to: window ? window.to : null,
      ineligible_dates: ineligibleDates,
      excluded_reason: window ? null : eligibility.exclusionReason(employment, from),
      punch_redrive: redrive,
      ...stored,
    };
  };

  /**
   * DEVICE TIME CORRECTION - the days a correction (or its reversal) produces,
   * calculated BEFORE anything is written, for the caller to store in the
   * same transaction as the correction itself.
   *
   * This is `setDateShift`'s pattern: the engine runs over the raw punches
   * with the corrected (or, for a revert, the original) times ASSUMED in
   * memory, through the ordinary `calculateRange`, so every derived value -
   * first IN, last OUT, worked, late, early exit, shortage, missing punch,
   * OT and authorised OT, status and review reasons - comes from the one
   * engine and nothing is bypassed.
   *
   * The same two rules `recalculateRange` applies to what it stores:
   *
   *   - ELIGIBILITY. A date outside the employee's employment, or any date of
   *     an employee exempt from attendance, is not calculated and is reported
   *     in `ineligible_dates`. Nothing is deleted here: the reconciliation of
   *     ineligible rows belongs to Recalculate, not to a clock correction.
   *   - CLOSED DATES ONLY. A date whose attendance day has not closed is
   *     calculated but NOT returned as a row to store; it reads live - with
   *     the correction - and is stored by the first recalculation after it
   *     closes (the daily 06:55 run included). Reported in
   *     `skipped_open_dates`.
   *
   * @param {object} input
   * @param {number} input.employee_id
   * @param {string[]} input.attendance_dates  the attendance dates whose
   *        punches the correction moves (usually one; two when a punch near
   *        the cutoff changes day)
   * @param {Map|object} input.assume_io_times  punch_id -> effective io_time
   * @returns {{rows: object[], days: object[], skipped_open_dates: object[], ineligible_dates: string[]}}
   */
  const calculateForTimeCorrection = async ({ employee_id, attendance_dates, assume_io_times, now = null }) => {
    const employeeId = Number(employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }
    const dates = [...new Set((attendance_dates || []).map(toDateOnly).filter(Boolean))].sort();
    if (dates.length === 0) return { rows: [], days: [], skipped_open_dates: [], ineligible_dates: [] };

    const employment = attendanceCalculationRepo.getEmploymentWindow
      ? await attendanceCalculationRepo.getEmploymentWindow(employeeId)
      : null;
    const eligible = dates.filter((date) => eligibility.eligibleWindow(employment, date, date));
    const ineligibleDates = dates.filter((date) => !eligible.includes(date));
    if (eligible.length === 0) {
      return { rows: [], days: [], skipped_open_dates: [], ineligible_dates: ineligibleDates };
    }

    const wanted = new Set(eligible);
    const calculated = (
      await calculateRange({
        employee_id: employeeId,
        from_date: eligible[0],
        to_date: eligible[eligible.length - 1],
        assume_io_times,
      })
    ).filter((day) => wanted.has(day.attendance_date));

    const { closed, skipped } = partitionClosedDays({ days: calculated, now: nowIs(now) });
    return {
      rows: closed.map(toStorageRow),
      days: closed,
      skipped_open_dates: skipped,
      ineligible_dates: ineligibleDates,
    };
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
   * left showing the old one. An OPEN or FUTURE date stores the override
   * alone - see below - because a day row written before the attendance day
   * closes would later be read back as that date's settled history.
   *
   * IDEMPOTENT. If the date already resolves to the requested shift - a retry
   * of a save that committed, or a no-op edit - no second override row is
   * appended; the date is simply recalculated and stored, which is the same
   * upsert a recalculation performs. Every appended row is the audit line:
   * employee, date, the shift before, the shift after, who, when.
   */
  const setDateShift = async ({ employee_id, attendance_date, work_shift_id, actor_employee_id, now = null }) => {
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

    // THE OVERRIDE IS A DECISION; THE DAY ROW IS A CALCULATION. The edit is
    // allowed for any date the screen shows - today and a future roster date
    // included - but a day row is stored only once that date's attendance
    // day has CLOSED (under the NEW shift's cutoff, which is the one the day
    // will be calculated under). Until then the override alone is saved, the
    // date reads LIVE_PREVIEW under the new shift, and the first ordinary
    // recalculation after it closes stores it.
    const dayState = attendanceDayState(after, { now });
    const rows = dayState.closed ? [toStorageRow(after)] : [];

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
        rows,
      });
    } else if (rows.length > 0) {
      stored = await attendanceCalculationRepo.saveCalculations(rows);
    } else {
      stored = { written: 0 };
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
      // Was the recalculated day stored? False while the date is still open:
      // `attendance_deferred` then says why and when it closes.
      attendance_persisted: rows.length > 0,
      attendance_deferred: dayState.closed
        ? null
        : { reason: dayState.reason, closes_at: dayState.closes_at },
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
   * BULK RECALCULATION: the Recalculate Attendance screen.
   *
   * A date range (required) and any subset of employee / store /
   * designation. The repository resolves the target employees, bounded by
   * employment: nobody who left before the range or joined after it, decided
   * by `resignation_date` and `date_of_joining` rather than by the hand-kept
   * `status` flag. An employee who joined DURING the range is recalculated
   * from their joining date, not from the start of the range. Each
   * employee is then recalculated through `recalculateRange` - the SAME
   * path as the single-employee endpoint, so every date resolves its own
   * dated shift assignment, the single-date override, the shift
   * configuration version in force, the break override and the approved
   * regularized punches - and stored in its own transaction. One employee's
   * failure is recorded and the run continues; the summary and the audit
   * row say exactly how many completed and how many did not.
   *
   * NO OT REQUEST IS CREATED. Candidate OT a recalculation finds is
   * AVAILABLE for the employee to request. No punch is written.
   *
   * A RANGE INTO TODAY OR THE FUTURE IS ACCEPTED, and only its CLOSED dates
   * are stored - see `recalculateRange`. The summary reports the open ones
   * (`attendance_days_skipped_open`, `open_dates_skipped`), so "through the
   * 30th" is never read back as "stored through the 30th".
   */
  const MAX_BULK_EMPLOYEES = 2000;

  const recalculateBulk = async ({
    from_date,
    to_date,
    employee_id = null,
    store_id = null,
    designation_id = null,
    actor_employee_id = null,
    now = null,
    // INTERNAL, never a route field. `false` for a SYSTEM-initiated run (the
    // daily 06:45 recalculation): it writes no `attendance_recalculation_run`
    // row, because that table can only say MANUAL or WORK_SHIFT_SAVE and a
    // scheduled run is neither - it would read as a manual run nobody asked
    // for. That caller records its own outcome in `api_sync_log` instead.
    record_run = true,
  }) => {
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }
    if (from > to) throw validationError("from_date must not be after to_date");
    if (dateRange(from, to).length > MAX_RANGE_DAYS) {
      throw validationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
    }

    const asId = (value, name) => {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw validationError(`${name} must be a positive id`);
      return n;
    };
    const employeeId = asId(employee_id, "employee_id");
    const storeId = asId(store_id, "store_id");
    const designationId = asId(designation_id, "designation_id");

    if (storeId !== null && !(await attendanceCalculationRepo.outletExists(storeId))) {
      throw validationError(`No outlet exists for store_id ${storeId}`);
    }
    if (designationId !== null && !(await attendanceCalculationRepo.designationExists(designationId))) {
      throw validationError(`No designation exists for designation_id ${designationId}`);
    }
    if (employeeId !== null && !(await attendanceCalculationRepo.getEmploymentWindow(employeeId))) {
      throw validationError(`No employee exists for employee_id ${employeeId}`);
    }

    const candidates = await attendanceCalculationRepo.listEmployeesForRecalculation({
      employee_id: employeeId,
      store_id: storeId,
      designation_id: designationId,
      from_date: from,
      to_date: to,
    });
    // THE SHARED ELIGIBILITY RULE, not a fourth copy of a bound.
    // `utils/attendance_eligibility.js` decides, from the same three facts
    // `recalculateRange` applies per employee below: `attendance_required`,
    // the joining date and the resignation date.
    //
    // AN INELIGIBLE CANDIDATE IS STILL PROCESSED, and that is the point. The
    // run is a reconciliation, not only a calculation: somebody who has just
    // been made exempt, or who has just resigned, is precisely the employee
    // whose stored days have to be removed, and filtering them out here is
    // what left those rows behind. `recalculateRange` calculates nothing for
    // them and deletes what the window still holds. The repository widens its
    // own candidate query by the same reasoning - see
    // `listEmployeesForRecalculation`.
    const processed = candidates || [];
    const isEligible = (e) => eligibility.eligibleInRange(e, from, to);
    // TARGETED still means "will have attendance calculated", which is what
    // the run record and every existing caller understand by it. The wider
    // set is reported beside it as RECONCILED, so a run that only removed
    // rows is visible rather than looking like a run that did nothing.
    const targets = processed.filter(isEligible);
    const excluded = processed
      .filter((e) => !isEligible(e))
      .map((e) => ({
        employee_id: Number(e.employee_id),
        employee_name: e.employee_name || null,
        reason: eligibility.exclusionReason(e, from),
      }));
    if (processed.length > MAX_BULK_EMPLOYEES) {
      throw validationError(
        `${processed.length} employees match; narrow the filters to at most ${MAX_BULK_EMPLOYEES}`
      );
    }

    const runId = record_run && attendanceCalculationRepo.insertRecalculationRun
      ? await attendanceCalculationRepo.insertRecalculationRun({
          requested_by_employee_id: actor_employee_id,
          from_date: from,
          to_date: to,
          employee_id: employeeId,
          store_id: storeId,
          designation_id: designationId,
          employees_targeted: targets.length,
        })
      : null;

    const errors = [];
    let completed = 0;
    let daysProcessed = 0;
    let staleRemoved = 0;
    // ONE INSTANT FOR THE WHOLE RUN, so two employees on the same shift cannot
    // get different open/closed answers for one date because the run took a
    // few seconds. Open and future dates are calculated but not persisted -
    // see `recalculateRange` - and are counted here rather than passed off
    // as processed.
    const runNow = nowIs(now);
    let daysSkippedOpen = 0;
    const skippedOpenDates = new Set();
    for (const target of processed) {
      /* eslint-disable no-await-in-loop */
      try {
        // The whole requested range is handed over. `recalculateRange` clamps
        // it to the employee's eligible window through the shared rule and
        // reconciles the REST of the window - which is exactly why the clamp
        // is no longer applied here: clamping twice would hide the ineligible
        // dates from the reconciliation that has to delete their stale rows.
        const result = await recalculateRange({
          employee_id: Number(target.employee_id),
          from_date: from,
          to_date: to,
          now: runNow,
        });
        if (isEligible(target)) completed += 1;
        daysProcessed += Number(result.written) || 0;
        staleRemoved += Number(result.stale_removed) || 0;
        (result.skipped_open_dates || []).forEach((entry) => {
          daysSkippedOpen += 1;
          skippedOpenDates.add(entry.attendance_date);
        });
      } catch (err) {
        errors.push({
          employee_id: Number(target.employee_id),
          employee_name: target.employee_name || null,
          message: err && err.message ? err.message : String(err),
          // The machine-readable reason, when there is one - so a caller can
          // tell a payroll-locked refusal (the lock doing its job) from a
          // failure.
          ...(err && err.code ? { code: err.code } : {}),
        });
      }
      /* eslint-enable no-await-in-loop */
    }

    const status =
      errors.length === 0
        ? "COMPLETED"
        : completed === 0 && targets.length > 0
        ? "FAILED"
        : "COMPLETED_WITH_ERRORS";

    if (runId && attendanceCalculationRepo.finishRecalculationRun) {
      await attendanceCalculationRepo.finishRecalculationRun(runId, {
        status,
        employees_completed: completed,
        employees_failed: errors.length,
        days_processed: daysProcessed,
        errors,
      });
    }

    return {
      run_id: runId,
      status,
      from_date: from,
      to_date: to,
      filters: { employee_id: employeeId, store_id: storeId, designation_id: designationId },
      employees_targeted: targets.length,
      employees_completed: completed,
      employees_failed: errors.length,
      attendance_days_processed: daysProcessed,
      // Reported, never silent: a run that removed rows has to say so, and
      // the employees it removed them for have to be nameable afterwards.
      stale_rows_removed: staleRemoved,
      // Employee-days in the requested range whose attendance day had not
      // closed when the run started: calculated, NOT stored, still read live.
      // `open_dates_skipped` is the distinct dates, so "through the 30th" is
      // never mistaken for "stored through the 30th".
      attendance_days_skipped_open: daysSkippedOpen,
      open_dates_skipped: [...skippedOpenDates].sort(),
      employees_reconciled: processed.length,
      employees_excluded: excluded.length,
      excluded,
      errors,
    };
  };

  /**
   * WORK SHIFT RULE PROPAGATION - what a Work Shift save does to the days
   * that shift decides.
   *
   * THE RULE. A shift's configuration is a statement about how the shift
   * works, not about one day, so changing it changes every attendance date
   * that shift governs whose payroll month is still OPEN - including dates in
   * the past, and including dates nobody has calculated yet. A month payroll
   * has approved and LOCKED is settled: its stored rows are the truth and it
   * is not recalculated, re-read or rewritten.
   *
   * WHAT IS IN SCOPE is decided from the DATED FACTS by
   * `utils/shift_propagation.js` - the assignment history, the single-date
   * overrides, the employment bounds, the latest date that can have closed,
   * and the payroll floor - never from which days happen to have a stored row
   * already. It persists only CLOSED dates, exactly as a manual run does.
   *
   * IT DUPLICATES NO ARITHMETIC. Every (employee, month) is handed to
   * `recalculateRange`, the same path the Recalculate button runs.
   *
   * IT IS NOT THE PAYROLL LOCK. The months it skips are read outside any
   * transaction and one could close between that read and the write; that
   * race is exactly what the `FOR UPDATE` gate in
   * `repository/attendance_calculation.js` exists for, and a month that locks
   * underneath this run is refused there and counted as skipped. Nothing here
   * weakens or bypasses that gate - it only avoids work the gate would reject.
   *
   * @param {number} work_shift_id
   * @param {number|null} actor_employee_id  stamped on the run record
   * @param {number|null} run_id             an already-created run to report
   *                                         into (the queued job's own row)
   * @param {function|null} onProgress       called between employee-months,
   *                                         so a long run can heartbeat
   */
  const recalculateForShiftConfigChange = async ({
    work_shift_id,
    actor_employee_id = null,
    run_id = null,
    queued_at = null,
    today = null,
    now = null,
    onProgress = null,
  }) => {
    const workShiftId = Number(work_shift_id);
    if (!Number.isInteger(workShiftId) || workShiftId <= 0) {
      throw validationError("work_shift_id is required and must be a work shift id");
    }
    if (!attendanceCalculationRepo.listShiftPropagationFacts) {
      return { skipped: true, reason: "NOT_SUPPORTED" };
    }

    const employees = (await attendanceCalculationRepo.listShiftPropagationFacts(workShiftId)) || [];
    const { work, skipped_locked } = propagationScope({
      workShiftId,
      employees,
      today: todayIs(today),
    });

    // THE REAL SCOPE, OVER THE PLACEHOLDER, BEFORE ANY WORK IS DONE.
    //
    // The queued row was written by the shift save's own transaction with
    // zero employees and the widest range a propagation could have, because
    // resolving a population is not something a save should do. Now that the
    // scope IS resolved, the row is corrected - so the screen shows what this
    // run is actually doing, and so a run that turns out to have nothing left
    // to do does not keep pretending it had work.
    if (run_id && attendanceCalculationRepo.updateRecalculationRunScope) {
      const dates = work.length > 0 ? work : skipped_locked;
      await attendanceCalculationRepo.updateRecalculationRunScope(run_id, {
        employees_targeted: new Set(work.map((w) => w.employee_id)).size,
        from_date:
          dates.length > 0
            ? dates.reduce((min, d) => (d.from_date < min ? d.from_date : min), dates[0].from_date)
            : todayIs(today),
        to_date:
          dates.length > 0
            ? dates.reduce((max, d) => (d.to_date > max ? d.to_date : max), dates[0].to_date)
            : todayIs(today),
      });
    }

    let runId = run_id;
    if (runId === null && work.length > 0 && attendanceCalculationRepo.insertRecalculationRun) {
      runId = await attendanceCalculationRepo.insertRecalculationRun({
        requested_by_employee_id: actor_employee_id,
        trigger_source: "WORK_SHIFT_SAVE",
        work_shift_id: workShiftId,
        from_date: work.reduce((min, w) => (w.from_date < min ? w.from_date : min), work[0].from_date),
        to_date: work.reduce((max, w) => (w.to_date > max ? w.to_date : max), work[0].to_date),
        employees_targeted: new Set(work.map((w) => w.employee_id)).size,
        status: "RUNNING",
      });
    }

    const errors = [];
    const lockedAfterQueue = new Set();
    // EMPLOYEE-LEVEL COUNTS ARE MUTUALLY EXCLUSIVE. An employee whose
    // September succeeded and whose October failed is a FAILED employee, not
    // both a completed and a failed one: the per-month detail lives in
    // `errors`, and the headline count must not add up to more employees than
    // the run touched.
    const succeededMonths = new Map(); // employee -> count
    const failedEmployees = new Set();
    let daysRecalculated = 0;
    let monthsRecalculated = 0;
    // The days this run will not touch because their month is settled,
    // counted from the scope rather than by enumerating a settled month.
    let skippedLockedDays = skipped_locked.reduce(
      (sum, entry) => sum + (Number(entry.day_count) || 0),
      0
    );

    // A MONTH LOCKED AFTER THIS PROPAGATION WAS OWED IS NOT AN ORDINARY SKIP.
    //
    // Payroll's Approve & Lock refuses to lock a month with a propagation
    // still pending for it, so this should not happen. If it does - a lock
    // that landed in the gap between that guard's read and this run reaching
    // the month, or a row locked by some path that predates the guard - then
    // a month has been settled against attendance this rule change never
    // reached, and nobody would ever find out from a silent skip. It is
    // recorded as an error on the run: visible, retryable, and naming the
    // employee and month a human has to look at.
    (queued_at ? skipped_locked : []).forEach((entry) => {
      if (!entry.locked_at || entry.locked_at <= queued_at) return;
      errors.push({
        employee_id: entry.employee_id,
        period: `${entry.month.slice(5, 7)}/${entry.month.slice(0, 4)}`,
        from_date: entry.from_date,
        to_date: entry.to_date,
        message:
          `Payroll for ${entry.month} was approved and locked at ${entry.locked_at}, after this ` +
          "shift-rule recalculation was queued. That month is frozen at figures calculated " +
          "before the rule changed, and only payroll can decide what to do about it.",
      });
      lockedAfterQueue.add(entry.employee_id);
    });
    const skippedLockedMonths = new Set(
      skipped_locked.map((entry) => `${entry.employee_id}|${entry.month}`)
    );

    // THE SAME CLOSED-DATE RULE AS A MANUAL RUN. The scope already ends the
    // day before today (today is never closed); whether that last day - or
    // any other - has closed under its own cutoff is decided per date by
    // `recalculateRange`, at one instant for the whole run.
    const runNow = nowIs(now, today);
    let daysSkippedOpen = 0;

    for (const item of work) {
      /* eslint-disable no-await-in-loop */
      try {
        const result = await recalculateRange({
          employee_id: item.employee_id,
          from_date: item.from_date,
          to_date: item.to_date,
          now: runNow,
        });
        daysSkippedOpen += (result.skipped_open_dates || []).length;
        daysRecalculated += Number(result.written) || 0;
        monthsRecalculated += 1;
        succeededMonths.set(item.employee_id, (succeededMonths.get(item.employee_id) || 0) + 1);
      } catch (err) {
        // A month that locked between the scope read and the write is not an
        // error: it is the lock doing its job, and it is counted as skipped.
        if (err && err.code === "PAYROLL_MONTH_LOCKED") {
          skippedLockedMonths.add(`${item.employee_id}|${item.month}`);
          skippedLockedDays += Number(item.day_count) || 0;
        } else {
          failedEmployees.add(item.employee_id);
          errors.push({
            employee_id: item.employee_id,
            period: `${String(item.period_month).padStart(2, "0")}/${item.period_year}`,
            from_date: item.from_date,
            to_date: item.to_date,
            message: err && err.message ? err.message : String(err),
          });
        }
      }
      if (onProgress) {
        try {
          await onProgress({ processed: monthsRecalculated + errors.length, total: work.length });
        } catch (progressErr) {
          // A heartbeat that fails must never fail the run it is reporting on.
        }
      }
      /* eslint-enable no-await-in-loop */
    }

    lockedAfterQueue.forEach((id) => failedEmployees.add(id));

    const targeted = new Set(work.map((w) => w.employee_id)).size;
    const completed = [...succeededMonths.keys()].filter((id) => !failedEmployees.has(id)).length;
    const status =
      errors.length === 0
        ? "COMPLETED"
        : completed === 0
        ? "FAILED"
        : "COMPLETED_WITH_ERRORS";

    if (runId && attendanceCalculationRepo.finishRecalculationRun) {
      await attendanceCalculationRepo.finishRecalculationRun(runId, {
        status,
        employees_completed: completed,
        employees_failed: failedEmployees.size,
        days_processed: daysRecalculated,
        days_skipped_locked: skippedLockedDays,
        errors,
      });
    }

    return {
      run_id: runId,
      work_shift_id: workShiftId,
      status,
      employees_targeted: targeted,
      employees_completed: completed,
      employees_failed: failedEmployees.size,
      employee_months_targeted: work.length,
      employee_months_recalculated: monthsRecalculated,
      attendance_days_recalculated: daysRecalculated,
      attendance_days_skipped_locked: skippedLockedDays,
      // Dates in scope whose attendance day had not closed yet (an overnight
      // cutoff can hold yesterday open): not persisted, still read live.
      attendance_days_skipped_open: daysSkippedOpen,
      months_skipped_locked: skippedLockedMonths.size,
      errors,
    };
  };

  /**
   * THE WORKER TICK. Recover what died, then process ONE queued run.
   *
   * ONE PER TICK on purpose: a tick that drained the whole queue would hold
   * the pool for as long as the queue is long and would starve the requests
   * the same process is serving. The cron ticks again in a minute, and a
   * backlog drains at one run a minute rather than in one burst.
   *
   * RE-ENTRANT NEVER. `processQueuedRecalculations` is guarded in-process so
   * a tick that overruns its minute makes the next one a no-op, and the
   * `status = 'QUEUED'` claim in the repository is what makes that safe
   * across processes as well.
   *
   * IT NEVER THROWS. A failed run is recorded ON the run - FAILED, with the
   * message - so the screen can show it and somebody can retry it; throwing
   * would only reach the cron's console.
   */
  let workerBusy = false;
  const processQueuedRecalculations = async ({ today = null, now = null } = {}) => {
    if (workerBusy) return { skipped: "in_progress" };
    if (!attendanceCalculationRepo.claimNextQueuedRun) return { skipped: "not_supported" };
    workerBusy = true;
    try {
      // RECOVERY MUST NEVER STOP THE QUEUE FROM DRAINING. It is housekeeping
      // for runs whose worker died; the tick's actual job is the run waiting
      // behind it. A recovery that throws - a lock timeout, a deadlock, a
      // constraint nobody predicted - is reported on the tick and the claim
      // still happens, so one unrecoverable row can never make every tick a
      // no-op for everybody else.
      let recovered = { superseded: 0, requeued: 0, abandoned: 0 };
      try {
        if (attendanceCalculationRepo.requeueStaleRecalculationRuns) {
          recovered = await attendanceCalculationRepo.requeueStaleRecalculationRuns();
        }
      } catch (err) {
        recovered = { error: err && err.message ? err.message : String(err) };
      }

      const run = await attendanceCalculationRepo.claimNextQueuedRun();
      if (!run) return { recovered, claimed: null };

      const runId = Number(run.attendance_recalculation_run_id);
      try {
        if (!run.work_shift_id) {
          throw validationError("a queued run carries no work shift to propagate");
        }
        const result = await recalculateForShiftConfigChange({
          work_shift_id: Number(run.work_shift_id),
          actor_employee_id: run.requested_by_employee_id || null,
          run_id: runId,
          queued_at: run.queued_at || null,
          today,
          now,
          onProgress: () => attendanceCalculationRepo.heartbeatRecalculationRun(runId),
        });
        return { recovered, claimed: runId, result };
      } catch (err) {
        if (attendanceCalculationRepo.failRecalculationRun) {
          await attendanceCalculationRepo.failRecalculationRun(
            runId,
            err && err.message ? err.message : String(err)
          );
        }
        return {
          recovered,
          claimed: runId,
          error: err && err.message ? err.message : String(err),
        };
      }
    } finally {
      workerBusy = false;
    }
  };

  /** Put a failed or partly failed run back in the queue. */
  const retryRecalculationRun = async (run_id) => {
    const runId = Number(run_id);
    if (!Number.isInteger(runId) || runId <= 0) {
      throw validationError("run_id is required and must be a run id");
    }
    if (!attendanceCalculationRepo.retryRecalculationRun) {
      return { code: 400, msg: "Retrying a run is not supported" };
    }
    const outcome = await attendanceCalculationRepo.retryRecalculationRun(runId);
    // The older forms answered a bare boolean; both shapes are accepted so a
    // partially deployed pair cannot turn a successful retry into a 422.
    const result = typeof outcome === "boolean" ? { requeued: outcome } : outcome || {};

    if (result.superseded_by_run_id) {
      // A NEWER QUEUED RUN FOR THE SAME SHIFT ALREADY OWES THIS WORK. It
      // carries the same latest configuration over the same open attendance,
      // so this run is closed rather than duplicated - and the caller is sent
      // to the run that is actually going to do it.
      return {
        code: 200,
        run_id: runId,
        status: "SUPERSEDED",
        superseded_by_run_id: result.superseded_by_run_id,
        msg:
          `A newer recalculation (run #${result.superseded_by_run_id}) is already queued for this ` +
          "shift and will apply the latest rules. This run has been closed as superseded.",
      };
    }
    if (!result.requeued) {
      return {
        code: 422,
        msg:
          "Only a shift-rule recalculation that failed, or completed with errors, " +
          "can be retried. Run a manual recalculation again from this screen instead.",
      };
    }
    return { code: 200, run_id: runId, status: "QUEUED" };
  };

  const getRecalculationRun = async (run_id) =>
    attendanceCalculationRepo.getRecalculationRun
      ? attendanceCalculationRepo.getRecalculationRun(Number(run_id))
      : null;

  const listRecalculationRuns = async (limit = 20) =>
    attendanceCalculationRepo.listRecalculationRuns
      ? (await attendanceCalculationRepo.listRecalculationRuns(limit)).map((r) => ({
          ...r,
          errors: typeof r.errors === "string" ? (() => { try { return JSON.parse(r.errors); } catch (e) { return []; } })() : r.errors || [],
        }))
      : [];

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
  const calculateMonth = async ({ employee_id, year, month, persist = false, now = null }) => {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw validationError("year and month must be integers, month 1-12");
    }

    const pad = (n) => String(n).padStart(2, "0");
    const from = `${y}-${pad(m)}-01`;
    const to = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;

    // READING A MONTH READS ITS STORED HISTORY; STORING ONE CALCULATES IT.
    // `persist=true` is a write - it is the recalculate key's, not the read
    // key's - so it must feed the engine's answer to the storage below. A
    // plain read must not: the month a payroll screen shows is the month that
    // was calculated, not a re-derivation of it against today's settings.
    const [days, employment, salary, employee] = await Promise.all([
      (persist ? calculateRange : readRange)({ employee_id, from_date: from, to_date: to }),
      attendanceCalculationRepo.getEmploymentWindow(employee_id),
      attendanceCalculationRepo.getMonthlyGrossAsOf(employee_id, to),
      attendanceCalculationRepo.getBreakOverride(employee_id),
    ]);

    const payroll = computeMonthlyAttendancePayroll({
      employee_id,
      year: y,
      month: m,
      monthly_gross: salary ? salary.monthly_gross : null,
      days,
      joined_on: employment ? employment.date_of_joining : null,
      ended_on: employment ? employment.resignation_date : null,
      // An employee exempt from biometric attendance is paid the month's
      // base days and no punch of theirs is priced - see the exemption note
      // in `utils/attendance_payroll.js`. They remain active, salaried and
      // payroll-eligible; the flag changes how attendance is READ, not
      // whether they are paid.
      attendance_required: attendanceRequired(employee),
    });

    const result = {
      ...payroll,
      salary_record_id: salary ? salary.salary_id : null,
      salary_effective_from: salary ? salary.effective_from : null,
      days,
    };

    if (persist) {
      // THE CLOSED-DATE GUARD, as for every general recalculation: a month
      // persisted mid-month stores its closed days only. The open and future
      // ones are reported, and keep reading live until they close and are
      // recalculated. The monthly roll-up is stored exactly as before - it
      // is the month's figure as of now, and was never final while any of
      // its days were open.
      const { closed, skipped } = partitionClosedDays({ days, now: nowIs(now) });
      result.skipped_open_dates = skipped;

      // ONE CALL, ONE TRANSACTION, ONE LOCK. The day rows and the monthly
      // roll-up are the same act of persistence: they used to be two calls,
      // and a month could be approved between them or left half written when
      // the second failed. The repository takes the payroll-row lock once and
      // holds it across both writes - see `saveMonthWithPayroll`.
      await attendanceCalculationRepo.saveMonthWithPayroll({
        employee_id,
        period_year: y,
        period_month: m,
        rows: closed.map(toStorageRow),
        monthly: {
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
        },
      });
    }

    return result;
  };

  /**
   * The SHIFT AS IT WOULD APPLY to one employee on one date - for a shift
   * they are not necessarily on.
   *
   * Used by the one-day shift request to answer the two questions it must
   * answer before a request may exist: does this shift even run on that
   * weekday, and is its NRM actually LONGER than the employee's own? Both go
   * through the very resolver the calculation uses, on the configuration
   * VERSION in force on that date, so the figure the employee is shown and
   * the figure the day is later calculated under are the same figure.
   *
   * `work_shift_id` omitted asks about the employee's OWN shift for the date,
   * which is the base the comparison is made against.
   */
  const shiftForDate = async ({ employee_id, attendance_date, work_shift_id = null }) => {
    const employeeId = Number(employee_id);
    const date = toDateOnly(attendance_date);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    const context = await buildContext({
      employee_id: employeeId,
      from: date,
      to: date,
      assume_override: work_shift_id ? { attendance_date: date, work_shift_id } : null,
    });

    // With an assumed override the resolution IS the asked-about shift; with
    // none it is the employee's own, from the dated history.
    const resolution = context.resolutionFor(date);
    const snapshot = resolution.snapshot;
    return {
      employee_id: employeeId,
      attendance_date: date,
      status: resolution.status,
      work_shift_id: resolution.work_shift_id,
      shift_code: snapshot ? snapshot.shift_code : null,
      shift_name: resolution.work_shift_id ? context.shiftNameFor(resolution.work_shift_id) : null,
      in_time: snapshot ? snapshot.in_time : null,
      out_time: snapshot ? snapshot.out_time : null,
      break_minutes: snapshot ? snapshot.break_minutes : null,
      is_working_day: snapshot ? snapshot.is_working_day : null,
      // NRM as the engine computes it from the shift alone: span less the
      // shift's own break. The employee's break override and Extra Break
      // Hours are deliberately NOT applied - they need a punched sequence
      // that does not exist yet on a date being requested in advance, and
      // this figure exists to COMPARE two shifts with each other.
      nrm_minutes: snapshot ? Math.max(0, (snapshot.shift_span_minutes || 0) - (snapshot.break_minutes || 0)) : null,
      // The PERMANENT shift for the date, whatever was asked about: the
      // comparison's other side, resolved from history with the overrides
      // withheld.
      base: (() => {
        const baseResolution = context.baseResolutionFor(date);
        const baseSnapshot = baseResolution.snapshot;
        return {
          status: baseResolution.status,
          work_shift_id: baseResolution.work_shift_id,
          shift_code: baseSnapshot ? baseSnapshot.shift_code : null,
          shift_name: baseResolution.work_shift_id
            ? context.shiftNameFor(baseResolution.work_shift_id)
            : null,
          in_time: baseSnapshot ? baseSnapshot.in_time : null,
          out_time: baseSnapshot ? baseSnapshot.out_time : null,
          is_working_day: baseSnapshot ? baseSnapshot.is_working_day : null,
          nrm_minutes: baseSnapshot
            ? Math.max(0, (baseSnapshot.shift_span_minutes || 0) - (baseSnapshot.break_minutes || 0))
            : null,
        };
      })(),
    };
  };

  /** The payroll lock, asked before an action rather than before a write. */
  const findPayrollLockedPeriods = (rows) =>
    attendanceCalculationRepo.findPayrollLockedPeriods
      ? attendanceCalculationRepo.findPayrollLockedPeriods(rows)
      : Promise.resolve([]);

  /**
   * The same answer for MANY employee/date pairs at once, for reports.
   *
   * Falls back to the per-period form when the repository predates it, so a
   * caller never has to ask which one it has.
   */
  const findPayrollLockedPeriodsBulk = (rows) =>
    attendanceCalculationRepo.findPayrollLockedPeriodsBulk
      ? attendanceCalculationRepo.findPayrollLockedPeriodsBulk(rows)
      : findPayrollLockedPeriods(rows);

  return {
    MAX_RANGE_DAYS,
    CALC_STATUS,
    RESOLUTION_STATUS,
    dateRange,
    breakOverrideMinutes,
    attendanceRequired,
    toStorageRow,
    OT_CLAIM_STATE,
    setOtRequestService,
    setPunchRedriveService,
    closeOtForPayrollLock,
    recalculateForShiftConfigChange,
    processQueuedRecalculations,
    retryRecalculationRun,
    getRecalculationRun,
    getBreakOverride,
    setBreakOverride,
    calculateRange,
    readRange,
    CALCULATION_SOURCE,
    calculateProposedDay,
    attendanceDateForPunchTime,
    calculateForTimeCorrection,
    attendanceDatesForPunchTimes,
    recalculateRange,
    recalculateBulk,
    listRecalculationRuns,
    setDateShift,
    shiftForDate,
    attendanceDayState,
    findPayrollLockedPeriods,
    findPayrollLockedPeriodsBulk,
    listDateShiftOptions,
    calculateMonth,
  };
};
