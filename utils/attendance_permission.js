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

module.exports = {
  PERMISSION_SOURCE,
  PERMISSION_STATE,
  PERMISSION_CLOSURE_REASON,
  permissionState,
  isPermissionEffective,
  mergeIntervals,
  clipIntervals,
  totalMinutes,
  overlapMinutes,
  overlapWithMany,
  allocatePermission,
};
