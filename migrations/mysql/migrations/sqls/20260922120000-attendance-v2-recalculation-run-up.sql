-- Attendance v2 - the audit of every BULK recalculation run.
--
-- ADDITIVE ONLY. One new table; nothing existing is altered and no
-- permission changes. `biomax_punch` is not touched.
--
-- One row per run of the Recalculate Attendance screen: who asked, when,
-- for which date range and which filters (employee, store, designation -
-- any subset), how many employees it targeted, how many completed and
-- failed, how many attendance days were (re)written, and the outcome. The
-- errors column carries the per-employee failures so a partial failure is
-- reported honestly rather than folded into a green summary.
--
-- NOTHING SENSITIVE. No salary figure of any kind is stored here: counts and
-- filter ids only.

CREATE TABLE IF NOT EXISTS `attendance_recalculation_run` (
  `attendance_recalculation_run_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `requested_by_employee_id` INT NULL COMMENT 'new_employee.employee_id of the actor',
  `started_at`     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at`   TIMESTAMP(3) NULL,
  `from_date`      DATE NOT NULL,
  `to_date`        DATE NOT NULL,
  `employee_id`    INT NULL COMMENT 'employee filter, NULL = not filtered',
  `store_id`       INT NULL COMMENT 'outlet filter, NULL = not filtered',
  `designation_id` INT NULL COMMENT 'designation filter, NULL = not filtered',
  `employees_targeted`  INT NOT NULL DEFAULT 0,
  `employees_completed` INT NOT NULL DEFAULT 0,
  `employees_failed`    INT NOT NULL DEFAULT 0,
  `days_processed`      INT NOT NULL DEFAULT 0 COMMENT 'attendance_day_calculation rows written',
  `status` ENUM('RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED') NOT NULL DEFAULT 'RUNNING',
  `errors` JSON NULL COMMENT 'per-employee failures: [{employee_id, message}]',
  PRIMARY KEY (`attendance_recalculation_run_id`),
  KEY `idx_arr_started` (`started_at`),
  KEY `idx_arr_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
