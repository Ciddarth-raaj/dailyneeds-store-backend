-- Payrun Calculation & Review - Unlock, Publish / Unpublish, and Net Pay rounding.
--
-- ADDITIVE ONLY. Three nullable columns on `payrun_employee_calculation`, one
-- new append-only audit table and two permission keys. No existing row is
-- written: every Approved & Locked month keeps its figures, its approval and
-- its status, and nothing is published by this migration.
--
-- PUBLISHED IS NOT A NEW `status` VALUE. It is `status = 'APPROVED_LOCKED'`
-- with `published_at` set. Every lock in the system - the attendance write
-- guard, the recalculation guard inside the save, the adjustment and pay type
-- refusals, Reset, the auto-refresh - tests `status = 'APPROVED_LOCKED'`, and
-- a published month must stay exactly as locked as an approved one. A new
-- status value would have quietly unlocked all of them.
--
-- Every statement is guarded so the file can be re-run without error.

SET @t = 'payrun_employee_calculation';

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'published_by') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `published_by` INT NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'published_at') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `published_at` TIMESTAMP NULL DEFAULT NULL COMMENT ''set = released for payslip / bank / downstream use. Only ever on an APPROVED_LOCKED row''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- THE ROUNDING THAT TOOK EARNINGS - DEDUCTIONS TO A WHOLE-RUPEE NET PAY, so
-- the stored figures still add up: total_earnings - total_employee_deductions
-- + net_pay_rounding = net_pay. NULL on rows calculated before rounding.
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'net_pay_rounding') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `net_pay_rounding` DECIMAL(6,2) NULL DEFAULT NULL COMMENT ''net_pay - (total_earnings - total_employee_deductions). NULL = calculated before rounding''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- THE LIFECYCLE LOG: LOCK, UNLOCK, PUBLISH, UNPUBLISH. Append-only, one row
-- per employee per act, with the reason, individual or bulk, and the status
-- either side. The approval history already in
-- `payrun_employee_calculation_audit` is never rewritten.
CREATE TABLE IF NOT EXISTS `payrun_employee_lifecycle_audit` (
  `payrun_lifecycle_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `payrun_calculation_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,
  `action` ENUM('LOCK','UNLOCK','PUBLISH','UNPUBLISH') NOT NULL,
  `previous_status` VARCHAR(32) NOT NULL,
  `new_status`      VARCHAR(32) NOT NULL,
  `reason` VARCHAR(500) NULL DEFAULT NULL,
  `remark` VARCHAR(500) NULL DEFAULT NULL,
  `mode`   ENUM('INDIVIDUAL','BULK') NOT NULL,
  `calculation_hash` CHAR(32) NULL DEFAULT NULL,
  `net_pay` DECIMAL(12,2) NULL DEFAULT NULL,
  `acted_by_employee_id` INT NULL DEFAULT NULL,
  `acted_by_user_id`     INT NULL DEFAULT NULL,
  `acted_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`payrun_lifecycle_audit_id`),
  KEY `idx_payrun_lifecycle_employee_month` (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_lifecycle_payrun` (`payrun_employee_id`),
  CONSTRAINT `fk_payrun_lifecycle_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only: lock, unlock, publish and unpublish of one employee month';

-- TWO KEYS, DECLARED AND GRANTED TO NOBODY (administrators through the
-- user_type 2 bypass). Reopening a signed-off month and releasing one for
-- downstream use are stronger acts than approving it, so neither rides on
-- `approve_payrun`.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
    SELECT 'unlock_payrun' AS `permission_key`
    UNION ALL SELECT 'publish_payrun'
  ) k
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key` );
