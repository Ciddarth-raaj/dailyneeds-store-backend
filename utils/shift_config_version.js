/**
 * Attendance v2 review fix #2 - Work Shift CONFIGURATION, effective-dated.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no clock.
 *
 * WHY THIS EXISTS. A0 already made the employee -> shift ASSIGNMENT
 * effective-dated, so moving somebody to a new shift in October stopped
 * rewriting September. It did not make the SHIFT ITSELF effective-dated, and
 * that left the same hole open one level down: editing a work shift's break,
 * its cutoff or its OT rules changed `work_shift` and
 * `work_shift_weekly_schedule` in place, and the next recalculation of an
 * already-settled September date read October's configuration. A payslip that
 * had already been paid could move because somebody corrected a shift.
 *
 * WHAT THIS ADDS. `work_shift_config_version` is an append-only, effective-
 * dated snapshot of the WHOLE definition of a shift: the master row's
 * attendance/OT columns plus all seven weekly-schedule rows, as one JSON
 * document with a content hash. Saving a Work Shift keeps writing the live
 * tables exactly as it always has - every existing screen, endpoint and reader
 * is untouched - and additionally appends a version row when the content
 * actually changed.
 *
 * THE RESOLUTION RULE, the same shape as the A0 assignment rule so there is
 * one idea to learn rather than two:
 *
 *     version(shift, date) = the row with the greatest effective_from <= date,
 *     and among equal dates the greatest id.
 *
 * A date EARLIER than the first version row falls back to the LIVE tables.
 * That is the cutover boundary and it is deliberate: the first version row is
 * seeded by the migration at the v2 cutover, so every date v2 can calculate is
 * covered, and a caller asking about an earlier date gets today's definition
 * with `from_live: true` said out loud rather than a silent null.
 *
 * NOTHING IS EVER DELETED OR OVERWRITTEN HERE. A version row is inserted and
 * then never changes, which is what makes "what did payroll actually use in
 * September" a question with an answer.
 */

const crypto = require("crypto");

/** Bumped when the shape of a stored version document changes. */
const CONFIG_VERSION_FORMAT = 1;

/**
 * The `work_shift` master columns that can change a calculated number.
 *
 * Everything else on that table - the shift's name, the legacy Full/Half-Day
 * settings, the regularization policy - is deliberately NOT versioned,
 * because none of it reaches the engine and versioning it would append a row
 * every time somebody fixed a typo in a shift name.
 */
const VERSIONED_CONFIG_COLUMNS = Object.freeze([
  "shift_code",
  // Lateness and early-out: the grace, and the interval-based deduction the
  // engine settles the shortage with. A document written before these were
  // versioned simply lacks the keys; the calculation usecase fills such a
  // gap from the LIVE row, so an old version never silently means "no grace".
  "late_grace_minutes",
  "late_deduction_interval_minutes",
  "late_deduct_minutes",
  "late_exclude_grace_from_deduction",
  "early_exit_grace_minutes",
  "early_exit_deduction_interval_minutes",
  "early_exit_deduct_minutes",
  "overtime_allowed",
  "overtime_minimum_minutes",
  "overtime_rounding_method",
  "overtime_rounding_interval_minutes",
  "overtime_minimum_threshold_only",
  "maximum_ot_minutes_per_day",
  "pre_shift_overtime_allowed",
  "pre_shift_overtime_minimum_minutes",
  "pre_shift_overtime_rounding_method",
  "pre_shift_overtime_rounding_interval_minutes",
  "late_offset_against_overtime",
  "early_exit_offset_against_overtime",
]);

/** The weekly-schedule columns that can change a calculated number. */
const VERSIONED_SCHEDULE_COLUMNS = Object.freeze([
  "day_of_week",
  "is_working_day",
  "in_time",
  "out_time",
  "attendance_day_cutoff",
  "break_minutes",
  "ot_rate",
]);

/** `YYYY-MM-DD` from a string or a Date, else null. Text compare is date compare. */
function toDateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** MySQL's TINYINT(1), a JS boolean and a string "1" all mean the same thing. */
const tinyBool = (value) => value === true || Number(value) === 1;

/**
 * One normalized version document for a shift.
 *
 * Normalized HERE rather than at read time, so that a version written today
 * and the same version read back in a year are byte-identical documents and
 * the hash of each is comparable. Times are trimmed to `HH:MM:SS`, booleans to
 * 0/1, numbers to integers, and the schedule is ordered by day_of_week with no
 * dependence on the order rows came back in.
 */
function buildConfigVersion(config, schedule) {
  const cfg = config || {};
  const normalizedConfig = {};
  VERSIONED_CONFIG_COLUMNS.forEach((column) => {
    const value = cfg[column];
    if (
      column === "overtime_allowed" ||
      column === "overtime_minimum_threshold_only" ||
      column === "pre_shift_overtime_allowed" ||
      column === "late_offset_against_overtime" ||
      column === "early_exit_offset_against_overtime" ||
      column === "late_exclude_grace_from_deduction"
    ) {
      normalizedConfig[column] = tinyBool(value) ? 1 : 0;
    } else if (column === "maximum_ot_minutes_per_day") {
      normalizedConfig[column] =
        value === null || value === undefined ? null : Math.max(0, Math.trunc(Number(value) || 0));
    } else if (column === "shift_code" || column.endsWith("rounding_method")) {
      normalizedConfig[column] =
        value === null || value === undefined ? null : String(value).toUpperCase();
    } else {
      normalizedConfig[column] = Math.max(0, Math.trunc(Number(value) || 0));
    }
  });

  const normalizedSchedule = (schedule || [])
    .map((row) => ({
      day_of_week: Number(row.day_of_week),
      is_working_day: tinyBool(row.is_working_day) ? 1 : 0,
      in_time: normalizeTime(row.in_time),
      out_time: normalizeTime(row.out_time),
      attendance_day_cutoff: normalizeTime(row.attendance_day_cutoff),
      break_minutes: Math.max(0, Math.trunc(Number(row.break_minutes) || 0)),
      ot_rate: Number(row.ot_rate === null || row.ot_rate === undefined ? 1 : row.ot_rate),
    }))
    .sort((a, b) => a.day_of_week - b.day_of_week);

  return {
    format: CONFIG_VERSION_FORMAT,
    config: normalizedConfig,
    schedule: normalizedSchedule,
  };
}

/**
 * `HH:MM[:SS]`, or a full `YYYY-MM-DD HH:MM[:SS]`, -> `HH:MM:SS`, else null.
 *
 * ANCHORED, so a malformed time is rejected rather than having a valid-looking
 * fragment picked out of the middle of it. An unanchored pattern would read
 * "9:5:00" as five past nine, which is a plausible guess at a value nobody
 * should be guessing at: a time this function cannot read is a configuration
 * error, and null is what says so.
 */
function normalizeTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = /^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(value).trim()
  );
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || mi > 59 || se > 59) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(mi)}:${pad(se)}`;
}

/**
 * A deterministic fingerprint of a version document.
 *
 * Built from a canonical string with the keys in a FIXED order, not from
 * `JSON.stringify` of an object whose key order is an accident of how the row
 * was assembled. Two processes that saw the same configuration produce the
 * same hash, which is what lets "has this shift actually changed" be a
 * comparison rather than a judgement.
 */
function configVersionHash(version) {
  const doc = version || {};
  const cfg = doc.config || {};
  const parts = [`format=${doc.format}`];
  VERSIONED_CONFIG_COLUMNS.forEach((column) => {
    parts.push(`${column}=${cfg[column] === null || cfg[column] === undefined ? "" : cfg[column]}`);
  });
  (doc.schedule || []).forEach((row) => {
    VERSIONED_SCHEDULE_COLUMNS.forEach((column) => {
      parts.push(
        `d${row.day_of_week}.${column}=${
          row[column] === null || row[column] === undefined ? "" : row[column]
        }`
      );
    });
  });
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * The version in force on `attendanceDate`, or null when the date precedes the
 * first version row.
 *
 * `versions` is one shift's history in any order. Rows are read, never
 * written: this function has no opinion about how a version comes to exist.
 */
function resolveConfigVersionForDate(versions, attendanceDate) {
  const date = toDateOnly(attendanceDate);
  if (date === null || !Array.isArray(versions)) return null;

  let best = null;
  let bestFrom = null;
  let bestId = -1;

  versions.forEach((row) => {
    if (!row) return;
    const from = toDateOnly(row.effective_from);
    if (from === null || from > date) return;
    const id = Number(row.work_shift_config_version_id) || 0;
    if (bestFrom === null || from > bestFrom || (from === bestFrom && id > bestId)) {
      best = row;
      bestFrom = from;
      bestId = id;
    }
  });

  return best;
}

/**
 * A resolved version turned back into the `{config, schedule}` pair the shift
 * resolver consumes, so a versioned read and a live read are the same shape
 * and `utils/shiftResolution.js` does not have to know which it got.
 *
 * `work_shift_id` is put back onto every row: it is not stored inside the
 * document, because a version belongs to exactly one shift and repeating the
 * id seven times inside the JSON would just be seven more things that could
 * disagree.
 */
function toShiftDefinition(versionRow, workShiftId) {
  if (!versionRow) return null;
  const doc =
    typeof versionRow.config_document === "string"
      ? JSON.parse(versionRow.config_document)
      : versionRow.config_document;
  if (!doc) return null;

  return {
    config: { ...doc.config, work_shift_id: Number(workShiftId) },
    schedule: (doc.schedule || []).map((row) => ({
      ...row,
      work_shift_id: Number(workShiftId),
      // The version does not carry the live schedule row's own id: that id
      // identifies a row that may since have been edited, and quoting it on a
      // historical calculation would point at configuration the calculation
      // did not use. The snapshot itself is the evidence.
      work_shift_weekly_schedule_id: null,
    })),
    config_version_id: Number(versionRow.work_shift_config_version_id) || null,
    config_version_hash: versionRow.config_hash || null,
    config_effective_from: toDateOnly(versionRow.effective_from),
    from_live: false,
  };
}

module.exports = {
  CONFIG_VERSION_FORMAT,
  VERSIONED_CONFIG_COLUMNS,
  VERSIONED_SCHEDULE_COLUMNS,
  toDateOnly,
  normalizeTime,
  buildConfigVersion,
  configVersionHash,
  resolveConfigVersionForDate,
  toShiftDefinition,
};
