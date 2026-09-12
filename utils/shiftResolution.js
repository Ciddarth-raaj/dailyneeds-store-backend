/**
 * Attendance v2 / A0 - which work shift applied on a given attendance date.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no clock. The caller fetches
 * the employee's assignment history and the shift's weekly schedule and hands
 * them over; everything here is arithmetic on those rows, which is what lets
 * the whole rule be tested without a MySQL instance.
 *
 * WHY THIS EXISTS. `new_employee.default_work_shift_id` is current state. It
 * answers "which shift is this person on today" and it is the right column for
 * the assignment screen and for dating a punch as it arrives. It is the WRONG
 * column for recalculating 3rd August in October: moving somebody to a new
 * shift would silently rewrite August's worked minutes, its shortage and its
 * overtime, and therefore a payslip that has already been paid. Historical
 * attendance has to stop moving, so it reads dated history instead.
 *
 * THE RULE, in full:
 *
 *     resolve(employee, date) = the assignment row with the greatest
 *     effective_from <= date, and among equal dates the greatest id.
 *
 * A date earlier than the employee's first row is NOT assigned. It does not
 * fall back to `default_work_shift_id` and it does not guess - the engine
 * reports NO_SHIFT_FOR_DATE and the date stays out of payroll until a human
 * fixes the cause. The migration that creates the history states the cutover
 * explicitly (2026-09-01) and invents nothing before it.
 *
 * THE SNAPSHOT. Resolution returns not only an id but a normalized snapshot of
 * the schedule row the calculation will consume, plus a stable hash of it. The
 * hash is what makes a recomputation auditable: if the stored hash for a date
 * no longer matches the one the current configuration produces, the shift
 * definition has been edited since, and that is visible rather than silent.
 *
 * THE SHIFT DEFINITION IS DATED TOO (review fix #2). `readSchedule` and
 * `readShiftConfig` are now handed the ATTENDANCE DATE as well as the shift
 * id, so the caller can hand back the configuration VERSION that applied on
 * that date (see `utils/shift_config_version.js`) rather than whatever the
 * live `work_shift` row says today. Resolving a date therefore answers both
 * halves of the question - which shift, and which version of it - and editing
 * a Work Shift tomorrow cannot move a settled September figure.
 */

const crypto = require("crypto");
const { parseTimeToMinutes, formatMinutesToTime, shiftSpanMinutes } = require("./workShift");

/** Why a date has no usable shift. Never a silent null. */
const RESOLUTION_STATUS = Object.freeze({
  OK: "OK",
  NO_SHIFT_FOR_DATE: "NO_SHIFT_FOR_DATE",
  NO_SCHEDULE_ROW: "NO_SCHEDULE_ROW",
  REST_DAY: "REST_DAY",
});

/**
 * The version stamped on every snapshot, so an old row says which rule built it.
 *
 * 2 = the review-fix snapshot: it carries the whole Shift Management OT rule
 * set (pre-shift OT and the two offset switches as well as post-shift OT) and
 * the provenance of the configuration VERSION it was built from.
 */
const SHIFT_SNAPSHOT_VERSION = 3;

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

/**
 * 0=Sunday..6=Saturday for a `YYYY-MM-DD`, computed with Date.UTC.
 *
 * Deliberately not `new Date(text).getDay()`: that builds a local date, so the
 * process timezone could move a Sunday shift onto Saturday's schedule row.
 */
function dayOfWeek(dateOnly) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * The assignment in force on `attendanceDate`.
 *
 * `assignments` is the employee's history, in any order. Rows are read, never
 * written: this function has no opinion about how history is appended.
 *
 * @returns {object|null} the winning row, or null when the date precedes the
 *   employee's first assignment.
 */
function resolveAssignmentForDate(assignments, attendanceDate) {
  const date = toDateOnly(attendanceDate);
  if (date === null || !Array.isArray(assignments)) return null;

  let best = null;
  let bestFrom = null;
  let bestId = -1;

  assignments.forEach((row) => {
    if (!row) return;
    const from = toDateOnly(row.effective_from);
    if (from === null || from > date) return;
    const id = Number(row.employee_work_shift_assignment_id) || 0;

    // Newest effective_from wins; a correction appended for the SAME date
    // wins on id, which is why history can be corrected without editing.
    if (bestFrom === null || from > bestFrom || (from === bestFrom && id > bestId)) {
      best = row;
      bestFrom = from;
      bestId = id;
    }
  });

  return best;
}

/**
 * The SINGLE-DATE override in force on `attendanceDate`, or null.
 *
 * `overrides` are `attendance_date_shift_override` rows, in any order. Only a
 * row whose date is EXACTLY the attendance date counts - an override is one
 * date, not a range, and it never leaks onto the day before or after. Among
 * several rows for the same date the greatest id wins, which is how a second
 * edit supersedes the first without either row being updated.
 */
function resolveOverrideForDate(overrides, attendanceDate) {
  const date = toDateOnly(attendanceDate);
  if (date === null || !Array.isArray(overrides)) return null;

  let best = null;
  let bestId = -1;
  overrides.forEach((row) => {
    if (!row || toDateOnly(row.attendance_date) !== date) return;
    const id = Number(row.attendance_date_shift_override_id) || 0;
    if (best === null || id > bestId) {
      best = row;
      bestId = id;
    }
  });
  return best;
}

/**
 * A deterministic fingerprint of the schedule values a calculation consumed.
 *
 * Only the fields that can change a number are hashed, and they are hashed in
 * a fixed order from a canonical string - not from `JSON.stringify` of an
 * object, whose key order is an accident of how the row was built. Two runs
 * that saw the same configuration produce the same hash on any machine.
 */
function snapshotHash(snapshot) {
  const canonical = [
    `v=${SHIFT_SNAPSHOT_VERSION}`,
    `shift=${snapshot.work_shift_id}`,
    `dow=${snapshot.day_of_week}`,
    `working=${snapshot.is_working_day ? 1 : 0}`,
    `in=${snapshot.in_time || ""}`,
    `out=${snapshot.out_time || ""}`,
    `cutoff=${snapshot.attendance_day_cutoff || ""}`,
    `break=${snapshot.break_minutes}`,
    `span=${snapshot.shift_span_minutes}`,
    `otrate=${snapshot.ot_rate}`,
    `ot_allowed=${snapshot.overtime_allowed ? 1 : 0}`,
    `ot_min=${snapshot.overtime_minimum_minutes}`,
    `ot_round=${snapshot.overtime_rounding_method}`,
    `ot_interval=${snapshot.overtime_rounding_interval_minutes}`,
    `ot_threshold_only=${snapshot.overtime_minimum_threshold_only ? 1 : 0}`,
    `ot_cap=${snapshot.maximum_ot_minutes_per_day === null ? "" : snapshot.maximum_ot_minutes_per_day}`,
    `pre_ot_allowed=${snapshot.pre_shift_overtime_allowed ? 1 : 0}`,
    `pre_ot_min=${snapshot.pre_shift_overtime_minimum_minutes}`,
    `pre_ot_round=${snapshot.pre_shift_overtime_rounding_method}`,
    `pre_ot_interval=${snapshot.pre_shift_overtime_rounding_interval_minutes}`,
    `late_offset=${snapshot.late_offset_against_overtime ? 1 : 0}`,
    `early_offset=${snapshot.early_exit_offset_against_overtime ? 1 : 0}`,
    `late_grace=${snapshot.late_grace_minutes}`,
    `late_grace_excluded=${snapshot.late_exclude_grace_from_deduction ? 1 : 0}`,
    `early_grace=${snapshot.early_exit_grace_minutes}`,
    `late_interval=${snapshot.late_deduction_interval_minutes}`,
    `late_deduct=${snapshot.late_deduct_minutes}`,
    `early_interval=${snapshot.early_exit_deduction_interval_minutes}`,
    `early_deduct=${snapshot.early_exit_deduct_minutes}`,
  ].join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

const tinyBool = (value) => value === true || Number(value) === 1;

const nonNegativeInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
};

/**
 * Build the audit-safe snapshot the engine calculates from.
 *
 * `scheduleRow` is one `work_shift_weekly_schedule` row; `shiftConfig` is the
 * `work_shift` master row. Both are normalized here so the engine never sees a
 * MySQL `"1"` where it expected a boolean or a `"09:00:00"` where it expected
 * minutes.
 */
function buildShiftSnapshot(scheduleRow, shiftConfig, dow) {
  const inMinutes = parseTimeToMinutes(scheduleRow.in_time);
  const outMinutes = parseTimeToMinutes(scheduleRow.out_time);
  const span = shiftSpanMinutes(inMinutes, outMinutes);
  const cfg = shiftConfig || {};

  const snapshot = {
    snapshot_version: SHIFT_SNAPSHOT_VERSION,
    work_shift_id: Number(scheduleRow.work_shift_id ?? cfg.work_shift_id) || null,
    work_shift_weekly_schedule_id:
      scheduleRow.work_shift_weekly_schedule_id === undefined
        ? null
        : Number(scheduleRow.work_shift_weekly_schedule_id),
    shift_code: cfg.shift_code === undefined ? null : cfg.shift_code,
    day_of_week: dow,
    is_working_day: tinyBool(scheduleRow.is_working_day),
    in_time: inMinutes === null ? null : formatMinutesToTime(inMinutes),
    out_time: outMinutes === null ? null : formatMinutesToTime(outMinutes),
    attendance_day_cutoff:
      parseTimeToMinutes(scheduleRow.attendance_day_cutoff) === null
        ? null
        : formatMinutesToTime(parseTimeToMinutes(scheduleRow.attendance_day_cutoff)),
    break_minutes: nonNegativeInt(scheduleRow.break_minutes, 0),
    shift_span_minutes: span === null ? 0 : span,
    ot_rate: Number(scheduleRow.ot_rate ?? 1),

    // Shift Management OT configuration, carried on the snapshot so a
    // recalculation of an old date uses the rules that date was calculated
    // under rather than whatever the shift says today.
    overtime_allowed: tinyBool(cfg.overtime_allowed),
    overtime_minimum_minutes: nonNegativeInt(cfg.overtime_minimum_minutes, 0),
    overtime_rounding_method: String(cfg.overtime_rounding_method || "NONE").toUpperCase(),
    overtime_rounding_interval_minutes: nonNegativeInt(cfg.overtime_rounding_interval_minutes, 0),
    overtime_minimum_threshold_only: tinyBool(cfg.overtime_minimum_threshold_only),
    maximum_ot_minutes_per_day:
      cfg.maximum_ot_minutes_per_day === null || cfg.maximum_ot_minutes_per_day === undefined
        ? null
        : nonNegativeInt(cfg.maximum_ot_minutes_per_day, 0),

    // PRE-shift OT, its own four columns. Defaulting `allowed` to false is the
    // safe direction: a shift that has never been configured for pre-shift OT
    // pays none, rather than paying for every early arrival.
    pre_shift_overtime_allowed: tinyBool(cfg.pre_shift_overtime_allowed),
    pre_shift_overtime_minimum_minutes: nonNegativeInt(cfg.pre_shift_overtime_minimum_minutes, 0),
    pre_shift_overtime_rounding_method: String(
      cfg.pre_shift_overtime_rounding_method || "NONE"
    ).toUpperCase(),
    pre_shift_overtime_rounding_interval_minutes: nonNegativeInt(
      cfg.pre_shift_overtime_rounding_interval_minutes,
      0
    ),

    // The two OFFSET switches. They subtract from OVERTIME and from nothing
    // else - v2 has no monetary late or early-exit penalty and these do not
    // create one. See the header of `utils/attendance_engine.js`.
    late_offset_against_overtime: tinyBool(cfg.late_offset_against_overtime),
    early_exit_offset_against_overtime: tinyBool(cfg.early_exit_offset_against_overtime),

    // Lateness and early-out GRACE. Minutes inside the grace are forgiven
    // from the day's shortage; see `applyGrace` in `utils/attendance_engine.js`
    // for exactly how the "Do Not Deduct Grace Minutes" switch is read.
    late_grace_minutes: nonNegativeInt(cfg.late_grace_minutes, 0),
    late_exclude_grace_from_deduction: tinyBool(cfg.late_exclude_grace_from_deduction),
    late_deduction_interval_minutes: nonNegativeInt(cfg.late_deduction_interval_minutes, 0),
    late_deduct_minutes: nonNegativeInt(cfg.late_deduct_minutes, 0),
    early_exit_grace_minutes: nonNegativeInt(cfg.early_exit_grace_minutes, 0),
    early_exit_deduction_interval_minutes: nonNegativeInt(cfg.early_exit_deduction_interval_minutes, 0),
    early_exit_deduct_minutes: nonNegativeInt(cfg.early_exit_deduct_minutes, 0),
  };

  // Which effective-dated CONFIGURATION VERSION this snapshot was built from,
  // carried so a stored calculation can name it. `null` means it came from the
  // live tables - either a date before the first version row, or a caller that
  // does not use versions at all.
  snapshot.config_version_id =
    cfg.config_version_id === undefined ? null : cfg.config_version_id;
  snapshot.config_version_hash =
    cfg.config_version_hash === undefined ? null : cfg.config_version_hash;
  snapshot.config_effective_from =
    cfg.config_effective_from === undefined ? null : cfg.config_effective_from;

  snapshot.snapshot_hash = snapshotHash(snapshot);
  return snapshot;
}

/**
 * The whole of A0 in one call: employee + date -> the shift that applied.
 *
 * @param {object} input
 * @param {Array}  input.assignments   the employee's assignment history rows
 * @param {Array}  [input.overrides]   the employee's single-date shift override
 *        rows; one dated EXACTLY `attendanceDate` wins over the history for
 *        that date only
 * @param {string} input.attendanceDate `YYYY-MM-DD`
 * @param {function} input.readSchedule (workShiftId, dayOfWeek, attendanceDate)
 *        => schedule row|null, for the configuration version in force on that date
 * @param {function} input.readShiftConfig (workShiftId, attendanceDate)
 *        => work_shift row|null, likewise
 * @returns {{status: string, work_shift_id: number|null, assignment: object|null,
 *            snapshot: object|null}}
 */
function resolveShiftForDate({
  assignments,
  overrides,
  attendanceDate,
  readSchedule,
  readShiftConfig,
}) {
  const date = toDateOnly(attendanceDate);

  // Precedence: a single-date override for EXACTLY this date, then the dated
  // assignment history. The override is shaped like an assignment row so the
  // rest of the resolution - and the snapshot the engine consumes - is the
  // same code either way; `source` says which it was.
  const override = resolveOverrideForDate(overrides, date);
  const assignment = override
    ? {
        employee_work_shift_assignment_id: null,
        attendance_date_shift_override_id: override.attendance_date_shift_override_id,
        employee_id: override.employee_id,
        work_shift_id: override.work_shift_id,
        effective_from: date,
        source: "DATE_OVERRIDE",
      }
    : resolveAssignmentForDate(assignments, date);

  if (!assignment) {
    return {
      status: RESOLUTION_STATUS.NO_SHIFT_FOR_DATE,
      work_shift_id: null,
      assignment: null,
      snapshot: null,
    };
  }

  const workShiftId = Number(assignment.work_shift_id);
  const dow = dayOfWeek(date);
  // The DATE is passed as well as the shift: a shift's configuration is itself
  // effective-dated, so "the Tuesday row of shift 7" is not a complete
  // question without saying which Tuesday.
  const scheduleRow = readSchedule(workShiftId, dow, date);
  if (!scheduleRow) {
    return {
      status: RESOLUTION_STATUS.NO_SCHEDULE_ROW,
      work_shift_id: workShiftId,
      assignment,
      snapshot: null,
    };
  }

  const snapshot = buildShiftSnapshot(
    { ...scheduleRow, work_shift_id: workShiftId },
    readShiftConfig ? readShiftConfig(workShiftId, date) : null,
    dow
  );

  return {
    // A rest day is a successful resolution with a real snapshot: somebody who
    // punches in on their day off has genuinely worked, and v2 pays by the day
    // attended rather than by the roster. The status says which it was so the
    // caller can tell the two apart.
    status: snapshot.is_working_day ? RESOLUTION_STATUS.OK : RESOLUTION_STATUS.REST_DAY,
    work_shift_id: workShiftId,
    assignment,
    snapshot,
  };
}

module.exports = {
  RESOLUTION_STATUS,
  SHIFT_SNAPSHOT_VERSION,
  toDateOnly,
  dayOfWeek,
  resolveAssignmentForDate,
  resolveOverrideForDate,
  buildShiftSnapshot,
  snapshotHash,
  resolveShiftForDate,
};
