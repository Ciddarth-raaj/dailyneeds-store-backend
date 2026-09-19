/**
 * STORED HISTORY IS WHAT A READ RETURNS. One rule, one place.
 *
 * ================================================================ WHY ======
 *
 * Every attendance screen used to RECALCULATE the date it was asked for, from
 * the punches and from the employee's settings AS THEY ARE NOW. That made a
 * stored historical row decorative: August had been calculated and stored with
 * no Extra Break Hours, and the moment somebody set the field today, opening
 * August showed a different permitted break and a different NRM - a month
 * nobody had recalculated, quietly restated, with no record that it had
 * changed and no way to see what it used to say.
 *
 * So: for an attendance date that has CLOSED and that already has a row in
 * `attendance_day_calculation`, a read returns THAT ROW. The engine is not
 * consulted for the numbers, and a read still writes nothing.
 *
 * ============================================================== THE RULE ===
 *
 *   stored row exists AND the date has closed   -> STORED
 *   anything else                               -> LIVE_PREVIEW
 *
 * The two cases that stay live are deliberate:
 *
 *   TODAY / AN OPEN DATE  is provisional by definition - people are still
 *                         punching - and a stored row for it is a snapshot of
 *                         a half-finished day. The dashboard already gates its
 *                         verdicts on the same `isDayClosed`, so "closed" here
 *                         is that same boundary and not a second one.
 *   NO STORED ROW         a historical date nobody has ever calculated has no
 *                         history to protect; showing the engine's answer is
 *                         better than showing nothing, and it is labelled as a
 *                         preview rather than passed off as settled.
 *
 * `calculation_source` travels on every day either way, so a caller - and a
 * reader of a screen - can always tell a settled figure from a projection.
 * It is NOT a stored column: it describes how THIS response was answered.
 *
 * ONLY AN EXPLICIT RECALCULATION REPLACES STORED HISTORY. That path is
 * unchanged: it calculates from punches, dated shift configuration and the
 * employee's current settings and persists the result - and it is now refused
 * outright for a payroll-locked month (`utils/attendance_payroll_lock.js`).
 */

const { punchEvidenceStale } = require("./attendance_missing_punch");

const CALCULATION_SOURCE = Object.freeze({
  STORED: "STORED",
  LIVE_PREVIEW: "LIVE_PREVIEW",
});

/** Integer or null - a stored INT column that is allowed to be absent. */
const intOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Integer, defaulting to 0 - a stored NOT NULL INT column. */
const int0 = (value) => {
  const n = intOrNull(value);
  return n === null ? 0 : n;
};

/**
 * A JSON column, whatever the driver handed back.
 *
 * `mysql` returns a JSON column as a parsed value on some server/driver
 * combinations and as a string on others, and this table's JSON columns were
 * written with `JSON.stringify`. Both are accepted; anything unparseable
 * becomes the fallback rather than throwing a read of somebody's attendance.
 */
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

/**
 * A stored row, in the shape the engine returns.
 *
 * FIELD FOR FIELD, and no arithmetic: every number here was computed when the
 * date was calculated and is reproduced exactly. Nothing is recomputed,
 * nothing is rounded, and no current setting is consulted.
 *
 * WHAT A STORED ROW CANNOT SUPPLY is supplied from the live day alongside it,
 * and only where it describes the DATE rather than the CALCULATION: the
 * shift's display name, where the assignment came from, and the raw/excluded
 * punch lists the audit panel shows. Those are evidence about the date as it
 * stands now; they never change a figure. `notes` are NOT carried over - they
 * narrate the live calculation and would describe a calculation this response
 * is not returning.
 */
function hydrateStoredDay(row, { live = null } = {}) {
  if (!row) return null;
  const snapshot = parseJson(row.shift_snapshot, null);
  const day = {
    employee_id: Number(row.employee_id),
    attendance_date: String(row.attendance_date),
    work_shift_id: row.work_shift_id === null || row.work_shift_id === undefined ? null : Number(row.work_shift_id),
    work_shift_weekly_schedule_id: intOrNull(row.work_shift_weekly_schedule_id),
    shift_snapshot: snapshot,
    shift_snapshot_hash: row.shift_snapshot_hash || "",
    raw_punch_ids: parseJson(row.raw_punch_ids, []),
    effective_punches: parseJson(row.effective_punches, []),
    punch_count: int0(row.punch_count),
    attendance_day_count: int0(row.attendance_day_count),
    nrm_minutes: int0(row.nrm_minutes),
    span_minutes: int0(row.span_minutes),
    break_allowance_minutes: int0(row.break_allowance_minutes),
    break_allowance_source: row.break_allowance_source || "SHIFT",
    // Provenance. NULL on every row written before the columns existed, and
    // reported as NULL rather than guessed at - see the migration.
    break_override_minutes_applied: intOrNull(row.break_override_minutes_applied),
    extra_break_minutes_applied: intOrNull(row.extra_break_minutes_applied),
    actual_gap_minutes: intOrNull(row.actual_gap_minutes),
    break_charged_minutes: int0(row.break_charged_minutes),
    worked_minutes: int0(row.worked_minutes),
    shortage_minutes: int0(row.shortage_minutes),
    late_minutes: intOrNull(row.late_minutes),
    early_exit_minutes: intOrNull(row.early_exit_minutes),
    pre_shift_minutes: int0(row.pre_shift_minutes),
    post_shift_minutes: int0(row.post_shift_minutes),
    raw_ot_minutes: int0(row.raw_ot_minutes),
    ot_offset_minutes: int0(row.ot_offset_minutes),
    pre_shift_ot_minutes: int0(row.pre_shift_ot_minutes),
    post_shift_ot_minutes: int0(row.post_shift_ot_minutes),
    candidate_ot_minutes: int0(row.candidate_ot_minutes),
    approved_ot_minutes: int0(row.approved_ot_minutes),
    ot_rate: row.ot_rate === null || row.ot_rate === undefined ? null : Number(row.ot_rate),
    status: row.status,
    is_final: Number(row.is_final) === 1,
    review_reasons: parseJson(row.review_reasons, []),
    approval_request_id:
      row.approval_request_id === null || row.approval_request_id === undefined
        ? null
        : Number(row.approval_request_id),
    calculation_version: intOrNull(row.calculation_version),
    calculated_at: row.calculated_at === undefined ? null : row.calculated_at,
    // The stored row narrates nothing; the notes belonged to a calculation
    // that ran when the date was stored and are not reproduced.
    notes: [],
    calculation_source: CALCULATION_SOURCE.STORED,
  };

  if (live) {
    // Evidence about the DATE, never a figure: the audit panel's punch lists
    // and the two display fields. A stored row keeps `raw_punch_ids`, which
    // is the reference list; the objects behind them are not stored.
    day.raw_punches = live.raw_punches || [];
    day.excluded_punches = live.excluded_punches || [];
    // WHETHER THE STORED PUNCHES ARE STILL THE PUNCHES. No figure is
    // recalculated and nothing is repaired - this only STATES that the row
    // was calculated from a different set of punches than the device now
    // shows, so a screen and the regularization guard agree about it instead
    // of each discovering it separately. See `utils/attendance_missing_punch.js`.
    day.punch_evidence_stale = punchEvidenceStale(day, live);
    day.live_punch_count = Number(live.punch_count) || 0;
  } else {
    day.punch_evidence_stale = false;
    day.live_punch_count = null;
  }
  return day;
}

/**
 * Which answer this date gets. The whole rule, in one predicate.
 *
 * `day_closed` is the caller's - both callers pass `isDayClosed` from
 * `utils/attendance_dashboard.js`, evaluated against the date's own resolved
 * shift, so an open day is open by exactly one definition.
 */
function useStoredDay({ stored = null, day_closed = false } = {}) {
  return Boolean(stored) && day_closed === true;
}

/** The live day, labelled. A read that computes is a preview and says so. */
function asLivePreview(day) {
  if (!day) return day;
  // A live day IS its own evidence: there is no stored row to have drifted.
  return {
    ...day,
    calculation_source: CALCULATION_SOURCE.LIVE_PREVIEW,
    punch_evidence_stale: false,
    live_punch_count: Number(day.punch_count) || 0,
  };
}

/**
 * The one decision, applied: the stored row when it rules, the live day
 * otherwise, each carrying its own provenance.
 */
function resolveDayForRead({ live = null, stored = null, day_closed = false } = {}) {
  if (useStoredDay({ stored, day_closed })) return hydrateStoredDay(stored, { live });
  return asLivePreview(live);
}

/** Stored rows keyed by `YYYY-MM-DD`, from whatever the repository returned. */
function byDate(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || !row.attendance_date) continue;
    map.set(String(row.attendance_date), row);
  }
  return map;
}

/** Stored rows keyed `employeeId:YYYY-MM-DD`, for the batched dashboard read. */
function byEmployeeAndDate(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || !row.attendance_date) continue;
    map.set(`${Number(row.employee_id)}:${String(row.attendance_date)}`, row);
  }
  return map;
}

module.exports = {
  CALCULATION_SOURCE,
  hydrateStoredDay,
  useStoredDay,
  asLivePreview,
  resolveDayForRead,
  byDate,
  byEmployeeAndDate,
};
