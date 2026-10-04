-- Drops exactly the thirteen columns the up-migration added. It discards the
-- stored PF ceiling evidence of every month calculated since; run it only to
-- roll the whole change back before any payroll has been calculated with it.

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'eps_wage') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `eps_wage`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'edli_wage') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `edli_wage`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'edli') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `edli`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_admin_charge') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `pf_admin_charge`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'ncp_days') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `ncp_days`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_ceiling_version') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `pf_ceiling_version`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'statutory_config_version') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `statutory_config_version`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_segments') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `pf_segments`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'pf_applicable_from') = 1,
  'ALTER TABLE `new_employee` DROP COLUMN `pf_applicable_from`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_scenario') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `pf_scenario`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'pf_exact') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `pf_exact`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'pf_contribution_basis') = 1,
  'ALTER TABLE `new_employee` DROP COLUMN `pf_contribution_basis`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'statutory_setup_marker') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `statutory_setup_marker`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
