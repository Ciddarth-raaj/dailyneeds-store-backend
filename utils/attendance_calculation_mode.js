/**
 * EMPLOYEE ATTENDANCE CALCULATION TYPE - the one resolver.
 *
 * An employee-level, EFFECTIVE-DATED attendance policy:
 *
 *   SHIFT_BASED          the default, and the existing engine unchanged.
 *   PRESENT_ABSENT_ONLY  a date with at least one effective punch is Present,
 *                        one complete payable attendance day; a date with none
 *                        is Absent. No shift is read and none is needed.
 *
 * It is configured per EMPLOYEE, never by designation or department, and it
 * is stored as an append-only history (`employee_attendance_calculation_mode`)
 * rather than as a current value, because a current value would make a
 * historical recalculation read today's rule for September.
 *
 * THE RULE, in one sentence - the same one the shift assignment history uses:
 *
 *     the row with the greatest effective_from <= attendance_date,
 *     and among those the greatest id; no row at all -> SHIFT_BASED.
 *
 * "No row" is the backward-compatibility guarantee. Nothing is backfilled, so
 * every employee resolves to SHIFT_BASED on every date until somebody states
 * otherwise from a date.
 *
 * EVERY CALCULATING PATH ASKS HERE. The calculation usecase (preview, stored
 * recalculation, bulk run, approvals, voids, the month) and the batched
 * dashboard (dashboard, staffing, missing attendance) both build a
 * `modeResolver` over the employee's history and ask it per date, so the two
 * cannot select the mode differently.
 *
 * PURE. No database, no clock. Dates are `YYYY-MM-DD`.
 */

const { toDateOnly } = require("./shiftResolution");

const ATTENDANCE_CALCULATION_MODE = Object.freeze({
  SHIFT_BASED: "SHIFT_BASED",
  PRESENT_ABSENT_ONLY: "PRESENT_ABSENT_ONLY",
});

const DEFAULT_ATTENDANCE_CALCULATION_MODE = ATTENDANCE_CALCULATION_MODE.SHIFT_BASED;

/** The words the screens use. One place, so a report and a screen agree. */
const ATTENDANCE_CALCULATION_MODE_LABEL = Object.freeze({
  SHIFT_BASED: "Shift Based",
  PRESENT_ABSENT_ONLY: "Present/Absent Only",
});

/**
 * What a Present/Absent Only date reports as its `shift_resolution_status`.
 *
 * The shift resolver's own answer (NO_SHIFT_FOR_DATE, NO_SCHEDULE_ROW ...) is
 * a statement about a roster, and every consumer of that field treats a
 * missing roster as a setup fault. On a Present/Absent Only date the roster
 * decides nothing, so its absence is not a fault and must not be reported as
 * one: the date reports this value instead, which no consumer mistakes for a
 * gap.
 */
const MODE_RESOLUTION_STATUS = "ATTENDANCE_MODE_PRESENT_ABSENT_ONLY";

function isKnownMode(value) {
  return value === ATTENDANCE_CALCULATION_MODE.SHIFT_BASED || value === ATTENDANCE_CALCULATION_MODE.PRESENT_ABSENT_ONLY;
}

/**
 * The history row in force on a date, or null.
 *
 * @param {Array} history `employee_attendance_calculation_mode` rows, any order
 * @param {string} attendanceDate `YYYY-MM-DD`
 */
function resolveModeRowForDate(history, attendanceDate) {
  const date = toDateOnly(attendanceDate);
  if (date === null || !Array.isArray(history)) return null;

  let best = null;
  let bestFrom = null;
  let bestId = -1;
  history.forEach((row) => {
    if (!row || !isKnownMode(row.calculation_mode)) return;
    const from = toDateOnly(row.effective_from);
    if (from === null || from > date) return;
    const id = Number(row.employee_attendance_calculation_mode_id) || 0;
    if (bestFrom === null || from > bestFrom || (from === bestFrom && id > bestId)) {
      best = row;
      bestFrom = from;
      bestId = id;
    }
  });
  return best;
}

/**
 * getEmployeeAttendanceCalculationType, as a pure function of the history.
 *
 * @returns {string} an ATTENDANCE_CALCULATION_MODE value - never null
 */
function resolveAttendanceCalculationMode(history, attendanceDate) {
  const row = resolveModeRowForDate(history, attendanceDate);
  return row ? row.calculation_mode : DEFAULT_ATTENDANCE_CALCULATION_MODE;
}

/** A memoized `(date) -> mode` over one employee's history. */
function modeResolver(history) {
  const rows = Array.isArray(history) ? history : [];
  const cache = new Map();
  return (date) => {
    const key = toDateOnly(date);
    if (cache.has(key)) return cache.get(key);
    const mode = resolveAttendanceCalculationMode(rows, key);
    cache.set(key, mode);
    return mode;
  };
}

function isPresentAbsentOnly(mode) {
  return mode === ATTENDANCE_CALCULATION_MODE.PRESENT_ABSENT_ONLY;
}

/**
 * The cutoff reader a punch is DATED with, made mode-aware.
 *
 * `attendanceDateForPunch` asks for the PREVIOUS calendar day's cutoff: a
 * 00:30 punch belongs to yesterday only if yesterday's shift claims the
 * morning after it. A Present/Absent Only date has no shift, so it claims no
 * morning - its punches are dated by the calendar. A Shift Based previous day
 * keeps its cutoff exactly as before, including on the first Present/Absent
 * Only date: the 00:30 end of the last shift-based night stays on that night.
 */
function modeAwareCutoffReader(readCutoff, modeFor) {
  return (date) => (isPresentAbsentOnly(modeFor(date)) ? null : readCutoff(date));
}

/**
 * THE ATTENDANCE DATE A RAW PUNCH IS PRESENTED UNDER on a read-only punch
 * screen, given only what ingest stored - the same answer the engine's
 * dating gives (`modeAwareCutoffReader` + `attendanceDateForPunch`).
 *
 * Ingest dated a punch with the SHIFT's cutoff (or could not date it). The
 * engine asks whether the PREVIOUS day claims a punch, and a Present/Absent
 * Only day claims nothing. So:
 *
 *   ingest date is a Present/Absent Only date  -> the CALENDAR date
 *        (the 02:00 punch ingest moved back onto 01/10 is 02/10's)
 *   ingest date is a Shift Based date          -> the ingest date, unchanged
 *        (including the last shift-based night's 00:30 OUT at a transition)
 *   ingest could not date it                   -> the calendar date if that
 *        date is Present/Absent Only; otherwise null, as before
 *
 * Whether the employee has, had or will have a shift plays no part: only the
 * mode of the date does. Raw punches are never changed by this - it decides
 * what a READ shows.
 *
 * @param {object} input
 * @param {string} input.calendar_date           `YYYY-MM-DD` of the punch instant
 * @param {string|null} input.ingest_attendance_date  what ingest stored
 * @param {function} input.modeFor               `(date) -> mode` for the employee
 */
function presentedAttendanceDate({ calendar_date, ingest_attendance_date = null, modeFor }) {
  const calendar = toDateOnly(calendar_date);
  const ingest = toDateOnly(ingest_attendance_date);
  if (ingest === null) {
    return calendar !== null && isPresentAbsentOnly(modeFor(calendar)) ? calendar : null;
  }
  return isPresentAbsentOnly(modeFor(ingest)) ? calendar : ingest;
}

/**
 * The dates a new history row actually changes: from its effective date up
 * to the day before the next EXISTING row that starts after it, or open-ended
 * (`to: null`) when none does.
 */
function affectedRangeForNewMode({ history, effectiveFrom }) {
  const from = toDateOnly(effectiveFrom);
  if (from === null) return null;
  let supersededFrom = null;
  (Array.isArray(history) ? history : []).forEach((row) => {
    const rowFrom = row ? toDateOnly(row.effective_from) : null;
    if (rowFrom === null || rowFrom <= from) return;
    if (supersededFrom === null || rowFrom < supersededFrom) supersededFrom = rowFrom;
  });
  return { from, superseded_from: supersededFrom };
}

module.exports = {
  ATTENDANCE_CALCULATION_MODE,
  ATTENDANCE_CALCULATION_MODE_LABEL,
  DEFAULT_ATTENDANCE_CALCULATION_MODE,
  MODE_RESOLUTION_STATUS,
  isKnownMode,
  isPresentAbsentOnly,
  resolveModeRowForDate,
  resolveAttendanceCalculationMode,
  modeResolver,
  modeAwareCutoffReader,
  presentedAttendanceDate,
  affectedRangeForNewMode,
};
