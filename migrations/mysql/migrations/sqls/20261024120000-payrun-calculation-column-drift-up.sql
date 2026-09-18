-- payrun_employee_calculation: the columns the deployed table never got.
--
-- ================================================== WHAT WENT WRONG ========
--
-- `20261023120000-payrun-calculation-up.sql` was deployed (d690fb4) and
-- recorded in db-migrate's `migrations` table. It was then EDITED IN PLACE
-- (1b0125f, "ESI coverage runs to the period's end, and OT is priced per NRM")
-- to add eight columns to `payrun_employee_calculation`:
--
--   ot_groups, esi_period_start, esi_period_end, esi_coverage_entry_date,
--   esi_coverage_entry_salary_id, esi_coverage_entry_gross,
--   esi_coverage_basis, esi_contribution_period_continues
--
-- db-migrate runs a file ONCE, by name. An already-recorded migration is never
-- re-run, and the statement is `CREATE TABLE IF NOT EXISTS` in any case, so on
-- production those eight columns were never created. The application shipped
-- reading and writing them:
-- `repository/payrun_calculation.js#listCalculations` names all eight in its
-- SELECT, and `COLUMNS` names all eight in its INSERT.
--
-- So every read of the month died in the database with
--
--   ER_BAD_FIELD_ERROR (1054): Unknown column 'ot_groups' in 'field list'
--
-- and GET /payrun/calculation/month answered 500 for EVERY month, whatever
-- the population and whatever the state of anybody's attendance. That is the
-- production failure behind "This payroll month's calculation could not be
-- loaded" with every counter at zero: the request never returned a month, so
-- the browser had nothing to count.
--
-- THE SAME EDIT DELETED A COLUMN. `attendance_ot_earnings` was a declared
-- column before 1b0125f and is only a comment after it - while the repository
-- still reads it and still writes it. Production HAS it (it was created by the
-- version that actually ran); a database created from the file as it stands
-- today would NOT, and would fail in exactly the same way. It is added here so
-- the two cases converge on one schema.
--
-- ================================================== WHAT THIS DOES =========
--
-- ADDITIVE, AND NOTHING ELSE. Nine `ADD COLUMN`s, each NULLable with no
-- default beyond NULL, each guarded on `information_schema` so the statement
-- is not even prepared where the column is already there. No row is written,
-- no column is dropped, narrowed or retyped, no index is touched, and no table
-- but this one is named. A database that already has all nine - any database
-- built from the current file, plus production once this has run - is left
-- bit-for-bit unchanged, so it is safe to run again.
--
-- NO BACKFILL, AND THAT IS DELIBERATE. Every column here is NULL-means-unknown
-- to the application: `esi_contribution_period_continues` NULL is "the
-- position at entry could not be established" and `ot_groups` NULL is "no
-- per-NRM breakdown was stored". Existing rows were calculated by an engine
-- that did not produce these values, and inventing one now would be this
-- migration deciding a payroll figure. The rows that need them get them from a
-- recalculation, which is a person's act.
--
-- THE DEPLOYED FILE IS NOT EDITED AGAIN. Editing an applied migration is what
-- caused this; the correction is a new file, which every database runs exactly
-- once, in order.

SET @t = 'payrun_employee_calculation';

-- --------------------------------------------------------------- the OT
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'attendance_ot_earnings') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `attendance_ot_earnings` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''reconciliation only - attendance''''s own OT price, used for no figure''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'ot_groups') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `ot_groups` JSON NULL COMMENT ''per-NRM OT breakdown that produced ot_amount''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ------------------------------------------- the ESI contribution period
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_period_start') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_period_start` DATE NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_period_end') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_period_end` DATE NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_coverage_entry_date') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_coverage_entry_date` DATE NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_coverage_entry_salary_id') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_coverage_entry_salary_id` INT NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_coverage_entry_gross') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_coverage_entry_gross` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''the gross of that record. Stored because it is a source marker, not for arithmetic''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_coverage_basis') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_coverage_basis` VARCHAR(48) NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'esi_contribution_period_continues') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `esi_contribution_period_continues` TINYINT(1) NULL DEFAULT NULL COMMENT ''1 covered at entry, 0 not, NULL could not be established''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
