-- EPFO statutory wage ceiling revision: 15,000 -> 25,000 w.e.f. 17-09-2026.
--
-- ADDITIVE ONLY. Eleven NULLable columns on `payrun_employee_calculation` that
-- make a calculation explain which effective-dated PF ceiling charged it and
-- carry the EPS / EDLI wages and NCP days an ECR needs, and two NULLable
-- columns on `new_employee`: `pf_applicable_from` (PF coverage starting part-way
-- through employment) and `pf_contribution_basis` (CEILING / ACTUAL_WAGE).
--
-- NO DATA IS WRITTEN. No row is updated, no employee is enrolled, no stored or
-- approved calculation is touched: existing rows read the new columns as NULL
-- and keep every figure they were approved with. Each ADD COLUMN is guarded by
-- information_schema, so a re-run is a no-op.

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'eps_wage') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `eps_wage` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''EPS (pension) wage the month was charged on''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'edli_wage') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `edli_wage` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''EDLI wage the month was charged on''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'edli') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `edli` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''employer EDLI contribution''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_admin_charge') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `pf_admin_charge` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''employer PF admin charge''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'ncp_days') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `ncp_days` INT NULL DEFAULT NULL COMMENT ''non-contributory days for the ECR: base days less salary days''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_ceiling_version') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `pf_ceiling_version` VARCHAR(96) NULL DEFAULT NULL COMMENT ''effective-dated PF ceiling version(s) that charged this month''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'statutory_config_version') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `statutory_config_version` VARCHAR(96) NULL DEFAULT NULL COMMENT ''config/statutory.js configVersion at calculation''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_segments') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `pf_segments` JSON NULL COMMENT ''per-period PF wages and contributions; two entries for September 2026''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'pf_applicable_from') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `pf_applicable_from` DATE NULL DEFAULT NULL COMMENT ''date PF coverage starts when enrolled part-way through employment; NULL = from joining''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_scenario') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `pf_scenario` VARCHAR(96) NULL DEFAULT NULL COMMENT ''per-period PF status and contribution basis, e.g. FAQ_B:EPF_ONLY>EPF_EPS|ACTUAL_WAGE''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_exact') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `pf_exact` JSON NULL COMMENT ''the month exact (paisa) PF/EPS/EDLI/admin figures before once-only rounding''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'pf_contribution_basis') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `pf_contribution_basis` ENUM(''CEILING'',''ACTUAL_WAGE'') NULL DEFAULT NULL COMMENT ''EPF contribution basis: CEILING = capped at the statutory ceiling, ACTUAL_WAGE = existing higher-wage contributor; NULL = configured default''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'statutory_setup_marker') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `statutory_setup_marker` CHAR(32) NULL DEFAULT NULL COMMENT ''md5 of the statutory setup facts the calculation used (source marker)''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
