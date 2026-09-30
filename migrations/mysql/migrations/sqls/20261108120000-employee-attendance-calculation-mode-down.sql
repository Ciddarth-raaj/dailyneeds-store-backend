-- `attendance_monthly_payroll`.`day_rows_fingerprint` is deliberately left at
-- VARCHAR(80). Narrowing it back to CHAR(64) would fail on (or require
-- discarding) every `v2:` fingerprint written since the up ran. The earlier
-- code reads a `v2:` value as a fingerprint that differs, so it refuses to
-- lock that month until the month is stored again - it fails closed.

ALTER TABLE `attendance_day_calculation` DROP COLUMN `attendance_calculation_mode`;

DROP TABLE IF EXISTS `employee_attendance_calculation_mode`;
