-- Attendance v2 - the SINGLE-DATE shift override.
--
-- ADDITIVE ONLY. One new table and one new permission key. No existing table
-- is altered, no existing row is rewritten, no permission is revoked and no
-- row of `biomax_punch` is touched.
--
-- WHY A SEPARATE TABLE. `employee_work_shift_assignment` is effective-FROM:
-- a row dated the 14th applies to the 14th AND every date after it until the
-- next row. That is the right shape for "moved to the evening shift", and it
-- is the wrong shape for "on the 14th only, this person covered the morning
-- shift" - appending an effective-from row for the 14th would silently move
-- the 15th, the 16th and the rest of the month as well, and a second row to
-- put them back is exactly the kind of two-step nobody remembers to do. The
-- approved UX is one date, one shift, Save; so the storage is one date, one
-- shift.
--
-- PRECEDENCE. The resolver (utils/shiftResolution.js) reads this table for
-- EXACTLY the attendance date being calculated and lets it win over the dated
-- assignment history for that date only. The day before and the day after
-- resolve through the assignment history exactly as they did, and the
-- employee's default/current shift is not read or written by this path.
--
-- APPEND-ONLY, LIKE THE HISTORY. A second edit of the same date INSERTs a
-- further row rather than updating the first; the newest row (greatest id)
-- wins. Every row therefore IS the audit line: the employee, the date, the
-- shift that applied before (`previous_work_shift_id`, as the resolver saw
-- it at the time), the shift it was changed to, who changed it and when.
--
-- The recalculated day for that date is written in the SAME transaction as
-- the override row, so an override can never be saved with the stored
-- attendance still showing the old shift.

CREATE TABLE IF NOT EXISTS `attendance_date_shift_override` (
  `attendance_date_shift_override_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`             INT  NOT NULL COMMENT 'new_employee.employee_id',
  `attendance_date`         DATE NOT NULL COMMENT 'the ONE attendance date this override applies to',
  `work_shift_id`           INT  NOT NULL COMMENT 'work_shift.work_shift_id that applies on that date',
  `previous_work_shift_id`  INT  NULL COMMENT 'the shift the resolver produced for the date before this row (NULL = none resolved)',
  `changed_by`              INT  NULL COMMENT 'new_employee.employee_id of the actor',
  `created_at`              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_date_shift_override_id`),
  -- The resolver's index: one employee, one date, newest row wins. No unique
  -- key - a later edit of the same date is a further row, never an update.
  KEY `idx_adso_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_adso_work_shift` (`work_shift_id`),
  CONSTRAINT `fk_adso_work_shift`
    FOREIGN KEY (`work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================================== permissions ====
--   edit_attendance_date_shift   change the shift of ONE attendance date   NOBODY
--
-- Granted to nobody by this migration: changing the shift a date is
-- calculated under changes that date's NRM, shortage and overtime, and so
-- its pay. Administrators reach it through the user_type 2 bypass; anybody
-- else is given it deliberately on the designation rights screen. It is NOT
-- implied by `view_calculated_attendance` or by either shift-assignment key.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_attendance_date_shift' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_attendance_date_shift');
