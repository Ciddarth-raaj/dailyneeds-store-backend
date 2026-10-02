/**
 * Locked-period attendance correction - the ATTENDANCE AND OT IMPACT of
 * correcting one attendance date inside a payroll month that is
 * `APPROVED_LOCKED`.
 *
 * Attendance only. Nothing here prices money: the frozen payrun row is never
 * read for amounts, never re-priced and never touched. What an audit event
 * records is the day before and after, and how worked time, break and OT
 * moved. Pure: no database, no clock.
 */

const isFinal = (day) => !!day && (day.is_final === true || Number(day.is_final) === 1);

function attendanceSummary(day) {
  if (!day) return null;
  const pick = (k) => (day[k] === undefined ? null : day[k]);
  return {
    attendance_date: pick("attendance_date"),
    status: pick("status"),
    is_final: isFinal(day),
    punch_count: pick("punch_count"),
    effective_punches: Array.isArray(day.effective_punches)
      ? day.effective_punches.map((p) => ({ io_time: p.io_time, source: p.source || null }))
      : typeof day.effective_punches === "string"
      ? (() => {
          try {
            return JSON.parse(day.effective_punches).map((p) => ({ io_time: p.io_time, source: p.source || null }));
          } catch (e) {
            return null;
          }
        })()
      : null,
    attendance_day_count: pick("attendance_day_count"),
    nrm_minutes: pick("nrm_minutes"),
    worked_minutes: pick("worked_minutes"),
    break_charged_minutes: pick("break_charged_minutes"),
    shortage_minutes: pick("shortage_minutes"),
    excess_ot_minutes: pick("excess_ot_minutes"),
    candidate_ot_minutes: pick("candidate_ot_minutes"),
    approved_ot_minutes: pick("approved_ot_minutes"),
  };
}

/** Minutes as an integer, or null when the day has no such figure. */
const minutesOrNull = (day, key) => {
  if (!day || day[key] === null || day[key] === undefined || day[key] === "") return null;
  const n = Math.trunc(Number(day[key]));
  return Number.isFinite(n) ? n : null;
};

/**
 * HOW THE CORRECTION MOVED THE DAY: worked minutes, break charged, OT eligible
 * and approved OT, before and after, with the change. Minutes only.
 */
function attendanceImpact(oldDay, newDay) {
  const pair = (key) => {
    const before = minutesOrNull(oldDay, key);
    const after = minutesOrNull(newDay, key);
    return { before, after, change: before === null || after === null ? null : after - before };
  };
  return {
    worked_minutes: pair("worked_minutes"),
    break_charged_minutes: pair("break_charged_minutes"),
    ot_eligible_minutes: pair("candidate_ot_minutes"),
    approved_ot_minutes: pair("approved_ot_minutes"),
  };
}

module.exports = {
  attendanceSummary,
  attendanceImpact,
};
