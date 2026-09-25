/**
 * THE EFFECTIVE TIME OF A RAW PUNCH, as SQL - in one place.
 *
 * `biomax_punch.io_time` is what the device stamped, and it is never changed.
 * When an administrator has recorded a DEVICE TIME CORRECTION for a punch
 * (the terminal's clock was wrong), the active row of
 * `attendance_device_time_correction_punch` carries the corrected time, and
 * that is the time attendance must use. With no active correction the
 * effective time IS the raw time.
 *
 * The join is on `active_biomax_punch_id`, the stored generated column that
 * holds the punch id only while the correction is active and carries a
 * UNIQUE KEY - so it can match at most one row, never fans a punch out, and
 * a reverted correction simply stops matching.
 *
 * Every repository that reads punches for calculation or display uses these
 * fragments with the raw punch aliased `p`, so no read can apply the rule
 * differently from another. See
 * `migrations/.../20261104120000-attendance-device-time-correction-up.sql`.
 */

/** LEFT JOIN of the active correction, alias `tc`. Needs `biomax_punch p`. */
const EFFECTIVE_TIME_JOIN = `LEFT JOIN attendance_device_time_correction_punch tc
         ON tc.active_biomax_punch_id = p.biomax_punch_id`;

/** The effective instant, as a DATETIME expression. */
const EFFECTIVE_IO_TIME = "COALESCE(tc.corrected_io_time, p.io_time)";

/**
 * The correction's audit columns, for a SELECT list. `original_io_time` is
 * ALWAYS the raw device time, corrected or not, so a screen can show both.
 */
const CORRECTION_COLUMNS = `DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s') AS original_io_time,
              tc.attendance_device_time_correction_id AS time_correction_id,
              tc.offset_minutes                       AS time_correction_offset_minutes`;

module.exports = { EFFECTIVE_TIME_JOIN, EFFECTIVE_IO_TIME, CORRECTION_COLUMNS };
