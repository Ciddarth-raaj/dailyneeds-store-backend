-- EMPLOYEE ATTENDANCE CALCULATION TYPE - an effective-dated, per-employee
-- attendance policy.
--
--   SHIFT_BASED          the existing engine, unchanged: shift resolution,
--                        NRM, shortage, late/early, missing punch, OT.
--   PRESENT_ABSENT_ONLY  a date with at least one effective punch is Present
--                        (one complete payable attendance day) and a date
--                        with none is Absent. No shift is needed and none is
--                        read: no late, early, shortage, NO_SHIFT or OT.
--
-- ADDITIVE ONLY. One new table, one new column with a default, and one
-- existing column widened. No existing row is rewritten and no permission is
-- granted or revoked.
--
-- 1. THE HISTORY. Append-only, exactly like `employee_work_shift_assignment`:
--    rows are INSERTed and never UPDATEd or DELETEd, and a date resolves to
--    the row with the greatest effective_from <= date, ties broken by the
--    greatest id (utils/attendance_calculation_mode.js). A later change
--    therefore never alters how an earlier date is interpreted, and a
--    historical recalculation reads the mode that applied ON THAT DATE, not
--    the employee's current one.
--
--    NO BACKFILL, AND THAT IS THE BACKWARD-COMPATIBILITY GUARANTEE. An
--    employee with no row - which is every employee when this runs - resolves
--    to SHIFT_BASED on every date. The mode is opt-in, per employee, from a
--    stated date.

CREATE TABLE IF NOT EXISTS `employee_attendance_calculation_mode` (
  `employee_attendance_calculation_mode_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`      INT  NOT NULL COMMENT 'new_employee.employee_id',
  `calculation_mode` ENUM('SHIFT_BASED','PRESENT_ABSENT_ONLY') NOT NULL,
  `effective_from`   DATE NOT NULL COMMENT 'inclusive attendance date from which this mode applies',
  `note`             VARCHAR(255) NULL,
  `created_by`       INT NULL COMMENT 'new_employee.employee_id of the actor',
  `created_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`employee_attendance_calculation_mode_id`),
  -- The resolver's index. No unique key: a same-date correction has to be
  -- insertable, and the resolver breaks the tie on id, newest wins.
  KEY `idx_eacm_employee_effective` (`employee_id`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. PROVENANCE ON THE STORED DAY. Which mode a stored calculation was made
--    under, so a stored row explains itself after the setting changes again.
--    Every existing row was calculated by the shift-based engine, which is
--    exactly what the default says - this is a true statement about them,
--    not a guess.
ALTER TABLE `attendance_day_calculation`
  ADD COLUMN `attendance_calculation_mode` ENUM('SHIFT_BASED','PRESENT_ABSENT_ONLY') NOT NULL DEFAULT 'SHIFT_BASED'
    COMMENT 'the employee attendance calculation mode this date was calculated under';

-- 3. ROOM FOR A VERSIONED MONTH FINGERPRINT. The day's calculation mode is now
--    one of the fields the monthly day-rows fingerprint is taken over
--    (utils/attendance_month_freshness.js), and the stored value is
--    `v2:<sha256>` (67 characters) so a fingerprint taken under the earlier
--    field list is recognisable and read as UNTRACKED rather than as a day
--    that changed. Widening only: every existing value is kept as it is, and
--    none is rewritten here - the month-fingerprint bootstrap rebuilds them
--    through the normal month persist.
ALTER TABLE `attendance_monthly_payroll`
  MODIFY COLUMN `day_rows_fingerprint` VARCHAR(80) NULL DEFAULT NULL
    COMMENT '<version>:sha256 of the stored day rows this summary was calculated from - see utils/attendance_month_freshness.js';
