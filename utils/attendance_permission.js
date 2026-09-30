/**
 * Attendance PERMISSION - the pure rules.
 *
 * A Permission is a management-approved window of the scheduled shift that
 * the employee was allowed NOT to work without losing pay: leave early on a
 * festival, come in late, step out mid-shift. It is PAID FORGIVEN SHORTAGE,
 * never worked time:
 *
 *   - it never adds a punch, never moves a punch and never changes the shift
 *     the date resolves to;
 *   - it never increases worked, regular, surplus or overtime minutes;
 *   - it may only take minutes OFF the shortage that would otherwise be
 *     charged, and only the minutes that fall inside the approved window.
 *
 * The engine (`utils/attendance_engine.js#applyGrace`) applies it in the
 * approved order:
 *
 *     grace  ->  permission  ->  the remaining shortage deduction rule
 *
 * so a minute grace already forgave can never be forgiven a second time by a
 * Permission, and the shift's interval deduction rule prices only what is
 * left.
 *
 * TWO ORIGINS, ONE CALCULATION.
 *
 *   REQUEST  raised by (or for) the employee and decided by the ordinary
 *            attendance approval chain (`attendance_approval_request` with
 *            request_type PERMISSION). Effective only when the request is
 *            APPROVED and SETTLED.
 *   DIRECT   granted by an authorised management user - one employee, a
 *            list, an outlet or everybody in scope (the festival early
 *            release). Effective from creation until revoked.
 *
 * Both reach the engine as the same `{from_minute, to_minute}` windows. The
 * engine does not know, and must not care, where a window came from.
 *
 * NO DATABASE, NO CLOCK, NO TIMEZONE, like the rest of the engine.
 */

const PERMISSION_SOURCE = Object.freeze({
  REQUEST: "REQUEST",
  DIRECT: "DIRECT",
});

/**
 * The state a Permission is in, DERIVED and never stored beside the facts it
 * describes (a stored enum next to the request status is one more thing that
 * could contradict it).
 */
const PERMISSION_STATE = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  // A REQUEST permission whose approved request was revoked (CANCELLED), or a
  // DIRECT grant somebody revoked.
  REVOKED: "REVOKED",
  // A pending REQUEST closed by the payroll lock.
  CLOSED_AT_PAYROLL_LOCK: "CLOSED_AT_PAYROLL_LOCK",
});

/** Why a pending Permission request was closed by the payroll lock. */
const PERMISSION_CLOSURE_REASON = "NOT_APPROVED_BEFORE_PAYROLL_LOCK";
/** The wording the employee and the approver read for it. */
const PERMISSION_CLOSURE_LABEL = "Closed – Not approved before payroll lock";

/**
 * The derived state of one permission row as the repository returns it:
 * `source`, `revoked_at`, and for a REQUEST the request's `request_status`,
 * `finalization_state` and `closure_reason`.
 */
function permissionState(row = {}) {
  if (!row) return null;
  if (row.source === PERMISSION_SOURCE.DIRECT) {
    return row.revoked_at ? PERMISSION_STATE.REVOKED : PERMISSION_STATE.APPROVED;
  }
  const status = row.request_status;
  if (status === "PENDING") return PERMISSION_STATE.PENDING;
  if (status === "APPROVED") return PERMISSION_STATE.APPROVED;
  if (status === "CANCELLED") return PERMISSION_STATE.REVOKED;
  if (status === "REJECTED") {
    return row.closure_reason ? PERMISSION_STATE.CLOSED_AT_PAYROLL_LOCK : PERMISSION_STATE.REJECTED;
  }
  return null;
}

/**
 * Does this row reach the calculation? A DIRECT grant until it is revoked; a
 * REQUEST only once its approval is APPROVED **and** SETTLED - the same rule
 * every other approval obeys (review fix #4): an approval whose day was never
 * written is not payroll-effective.
 */
function isPermissionEffective(row = {}) {
  if (!row) return false;
  if (row.source === PERMISSION_SOURCE.DIRECT) return !row.revoked_at;
  if (row.request_status !== "APPROVED") return false;
  const f = row.finalization_state;
  return f === undefined || f === null || f === "SETTLED";
}

/* ------------------------------------------------ rows -> the calculation */

/**
 * THE ONE PLACE a date's permission rows are turned into what the engine
 * reads, shared by the calculation usecase and the dashboard so the two can
 * never disagree about a date.
 *
 * `overlay` describes a change that is being committed in the caller's own
 * transaction and is therefore not in the rows yet - exactly as `assume`
 * does for an approval:
 *
 *   add                  DIRECT rows being granted now (no id yet)
 *   exclude_ids          permission ids being revoked now
 *   exclude_request_id   a PERMISSION request being revoked now
 *   approve_request_id   a PERMISSION request being finally approved now:
 *                        its rows count as APPROVED + SETTLED
 *
 * Returns every row with its derived `state` (for display) and the subset
 * that is effective (for the engine).
 */
function resolvePermissionRows(rows = [], overlay = null) {
  const o = overlay || {};
  const excludeIds = new Set((o.exclude_ids || []).map((id) => String(id)));
  const excludeRequest =
    o.exclude_request_id === null || o.exclude_request_id === undefined ? null : Number(o.exclude_request_id);
  const approveRequest =
    o.approve_request_id === null || o.approve_request_id === undefined ? null : Number(o.approve_request_id);

  const all = [...(rows || []), ...(o.add || [])]
    .filter((row) => row && !excludeIds.has(String(row.attendance_permission_id)))
    .map((row) => {
      const requestId =
        row.attendance_approval_request_id === null || row.attendance_approval_request_id === undefined
          ? null
          : Number(row.attendance_approval_request_id);
      if (row.source === PERMISSION_SOURCE.REQUEST && requestId !== null && requestId === excludeRequest) {
        return { ...row, request_status: "CANCELLED" };
      }
      if (row.source === PERMISSION_SOURCE.REQUEST && requestId !== null && requestId === approveRequest) {
        return { ...row, request_status: "APPROVED", finalization_state: "SETTLED" };
      }
      return row;
    })
    .map((row) => ({ ...row, state: permissionState(row) }));

  return { all, effective: all.filter(isPermissionEffective) };
}

/** Rows grouped by `attendance_date` (`YYYY-MM-DD`). */
function permissionsByDate(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || !row.attendance_date) continue;
    const date = String(row.attendance_date).slice(0, 10);
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(row);
  }
  return map;
}

const hhmm = (value) => {
  const m = /(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || "").trim());
  return m ? `${m[1]}:${m[2]}` : null;
};

/**
 * What a screen shows for one permission beside the day. Figures come from
 * the day itself (`permission_minutes`); this is the evidence: the window,
 * its origin, its state and who did what.
 */
function permissionForDisplay(row = {}) {
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    attendance_permission_id: num(row.attendance_permission_id),
    source: row.source,
    state: row.state || permissionState(row),
    attendance_date: row.attendance_date ? String(row.attendance_date).slice(0, 10) : null,
    permission_from: row.permission_from || null,
    permission_to: row.permission_to || null,
    from_time: hhmm(row.permission_from),
    to_time: hhmm(row.permission_to),
    to_shift_end: Number(row.to_shift_end) === 1,
    permission_minutes: num(row.permission_minutes),
    reason: row.reason || null,
    remarks: row.remarks || null,
    attendance_approval_request_id: num(row.attendance_approval_request_id),
    bulk_operation_id: row.bulk_operation_id || null,
    created_by_employee_id: num(row.created_by_employee_id),
    created_by_name: row.created_by_name || null,
    created_at: row.created_at || null,
    revoked_by_employee_id: num(row.revoked_by_employee_id),
    revoked_by_name: row.revoked_by_name || null,
    revoked_at: row.revoked_at || null,
    revoke_reason: row.revoke_reason || null,
    closure_reason: row.closure_reason || null,
  };
}

/* -------------------------------------------------------------- intervals */

const int = (v) => Math.trunc(Number(v));

/**
 * Sort and merge `[start, end)` minute intervals. Empty, inverted and
 * non-numeric intervals are dropped. Overlapping or touching windows become
 * one, so the same minute can never be counted twice however the windows
 * were entered.
 */
function mergeIntervals(intervals = []) {
  const clean = (intervals || [])
    .map((i) => (Array.isArray(i) ? [int(i[0]), int(i[1])] : [int(i && i.from_minute), int(i && i.to_minute)]))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of clean) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Keep only the parts of `intervals` inside `[from, to)`. */
function clipIntervals(intervals, from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return mergeIntervals(intervals)
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a);
}

/** Total minutes of `intervals` (merged first). */
function totalMinutes(intervals) {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);
}

/** Minutes of the (merged) `intervals` that fall inside `[from, to)`. */
function overlapMinutes(intervals, from, to) {
  return totalMinutes(clipIntervals(intervals, from, to));
}

/** Minutes of `intervals` inside ANY of the `windows`. */
function overlapWithMany(intervals, windows = []) {
  return mergeIntervals(windows).reduce((sum, [a, b]) => sum + overlapMinutes(intervals, a, b), 0);
}

/**
 * THE ALLOCATION, given the day's chargeable pieces after grace:
 *
 *   late    the late minutes still counted after grace, and the clock window
 *           they occupy - `[shiftIn + lateForgiven, firstPunch)`. Grace
 *           forgives the FIRST minutes of a late arrival, so the window the
 *           permission can reach starts after them.
 *   early   the early-out minutes still counted after grace, and
 *           `[lastPunch, shiftEnd)`.
 *   away    the break excess (the part of the OUT -> IN gaps beyond the
 *           allowance) and the gap windows themselves. The allowance is used
 *           up first: a permitted absence can only cover minutes that would
 *           otherwise have been charged.
 *
 * Each covered figure is the SMALLER of the permitted clock overlap and the
 * minutes that piece actually charges - so a permission can never reach time
 * the shortage does not contain (a late arrival worked off at the end of the
 * day, an uncharged break that already absorbed part of an early finish).
 */
function allocatePermission({
  permission_intervals = [],
  late_counted = 0,
  late_window = null,
  early_counted = 0,
  early_window = null,
  away_counted = 0,
  gap_windows = [],
} = {}) {
  const windows = mergeIntervals(permission_intervals);
  const nonNeg = (v) => Math.max(0, int(v) || 0);
  if (windows.length === 0) return { late: 0, early: 0, away: 0 };
  const lateClock = late_window ? overlapMinutes(windows, late_window[0], late_window[1]) : 0;
  const earlyClock = early_window ? overlapMinutes(windows, early_window[0], early_window[1]) : 0;
  const awayClock = overlapWithMany(windows, gap_windows || []);
  return {
    late: Math.min(lateClock, nonNeg(late_counted)),
    early: Math.min(earlyClock, nonNeg(early_counted)),
    away: Math.min(awayClock, nonNeg(away_counted)),
  };
}

/* ------------------------------------------- clock times -> the windows */

const MINUTES_PER_DAY = 1440;

/** `HH:MM[:SS]` -> minutes since midnight, else null. */
function clockToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value === undefined || value === null ? "" : value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** `YYYY-MM-DD` + n days, by UTC arithmetic. */
function addDaysUtc(dateOnly, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** An absolute minute from the attendance date's midnight -> `YYYY-MM-DD HH:MM:SS`. */
function minuteToDateTime(attendanceDate, minute) {
  const dayOffset = Math.floor(minute / MINUTES_PER_DAY);
  const inDay = minute - dayOffset * MINUTES_PER_DAY;
  const date = addDaysUtc(attendanceDate, dayOffset);
  return `${date} ${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}:00`;
}

const PERMISSION_WINDOW_ERROR = Object.freeze({
  NO_SHIFT: "NO_SHIFT",
  NOT_WORKING_DAY: "NOT_WORKING_DAY",
  BAD_TIME: "BAD_TIME",
  EMPTY_WINDOW: "EMPTY_WINDOW",
  OUTSIDE_SHIFT: "OUTSIDE_SHIFT",
  WHOLE_SHIFT: "WHOLE_SHIFT",
  OVERLAPPING_WINDOWS: "OVERLAPPING_WINDOWS",
});

/**
 * Turn requested clock windows into stored date-time windows INSIDE the
 * date's resolved shift.
 *
 * `shift` is `{in_time, shift_span_minutes, is_working_day}` for the date.
 * Each window is `{from_time, to_time}` or `{from_time, to_shift_end: true}`.
 * A clock time earlier than the shift's in-time is read as the next calendar
 * morning when the shift runs past midnight - an 18:00-02:00 shift's "01:00"
 * is 01:00 the following day, as a punch would be.
 *
 *   clip = false  (one employee, a person choosing the times) - a window
 *                 reaching outside the shift is REFUSED, so nobody approves a
 *                 period the calculation would silently cut down.
 *   clip = true   (a bulk grant, one rule for many different shifts) - each
 *                 window is cut to the employee's own shift; a window that
 *                 then covers nothing, or the whole shift, is refused for
 *                 that employee. A whole shift away is leave, not permission.
 *
 * Returns `{ ok: true, windows: [...] }` or `{ ok: false, code, message }`.
 */
function resolvePermissionWindows({ attendance_date, shift, windows = [], clip = false } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!shift || shift.in_time === null || shift.in_time === undefined) {
    return fail(PERMISSION_WINDOW_ERROR.NO_SHIFT, `No work shift is assigned for ${attendance_date}`);
  }
  if (!(shift.is_working_day === true || Number(shift.is_working_day) === 1)) {
    return fail(PERMISSION_WINDOW_ERROR.NOT_WORKING_DAY, `${attendance_date} is not a working day on this shift`);
  }
  const shiftIn = clockToMinutes(shift.in_time);
  const span = Math.max(0, Math.trunc(Number(shift.shift_span_minutes) || 0));
  if (shiftIn === null || span <= 0) {
    return fail(PERMISSION_WINDOW_ERROR.NO_SHIFT, `The work shift for ${attendance_date} has no hours`);
  }
  const shiftEnd = shiftIn + span;
  const place = (m) => (m >= shiftIn ? m : m + MINUTES_PER_DAY <= shiftEnd ? m + MINUTES_PER_DAY : m);
  const label = (m) => minuteToDateTime(attendance_date, m).slice(11, 16);

  if (!Array.isArray(windows) || windows.length === 0) {
    return fail(PERMISSION_WINDOW_ERROR.EMPTY_WINDOW, "At least one permission window is required");
  }

  const out = [];
  for (const w of windows) {
    const fromClock = clockToMinutes(w && w.from_time);
    const toShiftEnd = Boolean(w && w.to_shift_end);
    const toClock = toShiftEnd ? null : clockToMinutes(w && w.to_time);
    if (fromClock === null || (!toShiftEnd && toClock === null)) {
      return fail(PERMISSION_WINDOW_ERROR.BAD_TIME, "Permission times must be HH:MM");
    }
    let from = place(fromClock);
    let to = toShiftEnd ? shiftEnd : place(toClock);
    if (!toShiftEnd && to <= from) to += MINUTES_PER_DAY;

    if (clip) {
      from = Math.max(from, shiftIn);
      to = Math.min(to, shiftEnd);
      if (to <= from) {
        return fail(
          PERMISSION_WINDOW_ERROR.OUTSIDE_SHIFT,
          `The window falls outside the shift (${label(shiftIn)} - ${label(shiftEnd)})`
        );
      }
    } else if (from < shiftIn || to > shiftEnd || to <= from) {
      return fail(
        PERMISSION_WINDOW_ERROR.OUTSIDE_SHIFT,
        `A permission must lie inside the scheduled shift (${label(shiftIn)} - ${label(shiftEnd)})`
      );
    }
    if (from <= shiftIn && to >= shiftEnd) {
      return fail(
        PERMISSION_WINDOW_ERROR.WHOLE_SHIFT,
        "A permission cannot cover the whole shift - a day away is leave, not permission"
      );
    }
    out.push({
      from_minute: from,
      to_minute: to,
      permission_from: minuteToDateTime(attendance_date, from),
      permission_to: minuteToDateTime(attendance_date, to),
      to_shift_end: toShiftEnd,
      permission_minutes: to - from,
    });
  }

  const merged = mergeIntervals(out.map((w) => [w.from_minute, w.to_minute]));
  if (totalMinutes(merged) !== out.reduce((sum, w) => sum + w.permission_minutes, 0)) {
    return fail(PERMISSION_WINDOW_ERROR.OVERLAPPING_WINDOWS, "The permission windows overlap each other");
  }
  if (merged.length === 1 && merged[0][0] <= shiftIn && merged[0][1] >= shiftEnd) {
    return fail(
      PERMISSION_WINDOW_ERROR.WHOLE_SHIFT,
      "A permission cannot cover the whole shift - a day away is leave, not permission"
    );
  }
  return {
    ok: true,
    shift_from: minuteToDateTime(attendance_date, shiftIn),
    shift_to: minuteToDateTime(attendance_date, shiftEnd),
    windows: out.sort((a, b) => a.from_minute - b.from_minute),
  };
}

/*
 * PRESENT/ABSENT ONLY: PERMISSION IS NOT APPLICABLE.
 *
 * A Permission forgives shortage against a shift. On a date whose effective
 * Attendance Calculation Type is PRESENT_ABSENT_ONLY there is no late, early
 * or short for it to forgive, so a new one is refused - requested, granted
 * or approved. The date's own effective mode decides (the one resolver in
 * utils/attendance_calculation_mode.js), never today's mode, a shift or a
 * designation. Historical records on such a date are left exactly as they
 * are; the engine applies them as zero.
 */
const PERMISSION_NOT_APPLICABLE_CODE = "PERMISSION_NOT_APPLICABLE_PRESENT_ABSENT_ONLY";
const PERMISSION_NOT_APPLICABLE_MESSAGE =
  "Permission is not applicable because this employee uses Present/Absent Only attendance.";

/** The refusal, in the repo's business-rule convention (HTTP 400). */
function permissionNotApplicableError() {
  const err = new Error(PERMISSION_NOT_APPLICABLE_MESSAGE);
  err.name = "ValidationError";
  err.code = PERMISSION_NOT_APPLICABLE_CODE;
  return err;
}

module.exports = {
  PERMISSION_NOT_APPLICABLE_CODE,
  PERMISSION_NOT_APPLICABLE_MESSAGE,
  permissionNotApplicableError,
  PERMISSION_WINDOW_ERROR,
  resolvePermissionWindows,
  clockToMinutes,
  minuteToDateTime,
  PERMISSION_SOURCE,
  PERMISSION_STATE,
  PERMISSION_CLOSURE_REASON,
  PERMISSION_CLOSURE_LABEL,
  permissionState,
  isPermissionEffective,
  resolvePermissionRows,
  permissionsByDate,
  permissionForDisplay,
  mergeIntervals,
  clipIntervals,
  totalMinutes,
  overlapMinutes,
  overlapWithMany,
  allocatePermission,
};
