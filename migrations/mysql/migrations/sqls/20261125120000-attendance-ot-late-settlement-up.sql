-- Prior-Month OT carry-forward: OT approved AFTER its payroll month was locked
-- is settled FORWARD, in the next eligible open payroll, as "Prior-Month OT".
--
-- ADDITIVE ONLY. Two new tables and two NULLable columns on
-- `payrun_employee_calculation`. No existing row is rewritten. A locked
-- payroll month, its calculation, its payslip and its net pay are never
-- touched by anything this feature does - it is a forward settlement only.
--
-- APPROVAL AND SETTLEMENT ARE TWO DIFFERENT STATUSES ON PURPOSE. The OT
-- request keeps its own approval lifecycle (`attendance_approval_request`:
-- PENDING -> APPROVED / REJECTED). The MONEY has its own, here:
--
--   PENDING_SETTLEMENT  approved after its month locked; no payroll has it yet
--   INCLUDED            in an OPEN payroll month's calculation (provisional:
--                       a Reset of that month releases it, a recalculation
--                       keeps it there)
--   SETTLED             that payroll month was Approved & Locked: paid
--   CANCELLED           the approval was revoked before it was settled
--
-- ONE ROW PER OT REQUEST, ENFORCED BY THE DATABASE (`uq_aols_request`): the
-- same OT can never be settled twice. The original date, month and minutes,
-- the locked calculation it was priced from, the price, and the settlement
-- payroll month all live on the row.

CREATE TABLE IF NOT EXISTS `attendance_ot_late_settlement` (
  `late_settlement_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL COMMENT 'the OT date (original month)',
  `source_year`  SMALLINT NOT NULL,
  `source_month` TINYINT NOT NULL,
  `eligible_ot_minutes` INT NOT NULL COMMENT 'the system-calculated eligible OT at approval',
  `approved_ot_minutes` INT NOT NULL,

  -- THE PRICE, frozen at approval on the ORIGINAL month's basis.
  `source_payrun_calculation_id` BIGINT UNSIGNED NULL COMMENT 'the locked calculation whose daily rate priced it',
  `source_daily_rate` DECIMAL(12,2) NOT NULL,
  `nrm_minutes` INT NOT NULL COMMENT 'the OT date''s stored NRM',
  `ot_hourly_rate` DECIMAL(12,2) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,

  `settlement_status` ENUM('PENDING_SETTLEMENT','INCLUDED','SETTLED','CANCELLED') NOT NULL DEFAULT 'PENDING_SETTLEMENT',
  `settlement_year`  SMALLINT NULL,
  `settlement_month` TINYINT NULL,
  `settlement_payrun_calculation_id` BIGINT UNSIGNED NULL,

  `approved_by` INT NULL,
  `approved_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `included_at` TIMESTAMP(3) NULL,
  `settled_at`  TIMESTAMP(3) NULL,
  `cancelled_at` TIMESTAMP(3) NULL,
  `updated_at`  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`late_settlement_id`),
  UNIQUE KEY `uq_aols_request` (`attendance_approval_request_id`),
  KEY `idx_aols_employee_status` (`employee_id`, `settlement_status`),
  KEY `idx_aols_settlement_month` (`settlement_year`, `settlement_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every move of the money, append-only: who/what moved it, and to which
-- payroll month.
CREATE TABLE IF NOT EXISTS `attendance_ot_late_settlement_log` (
  `late_settlement_log_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `late_settlement_id` BIGINT UNSIGNED NOT NULL,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `from_status` VARCHAR(24) NULL,
  `to_status`   VARCHAR(24) NOT NULL,
  `settlement_year`  SMALLINT NULL,
  `settlement_month` TINYINT NULL,
  `actor_employee_id` INT NULL,
  `note` VARCHAR(255) NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`late_settlement_log_id`),
  KEY `idx_aolsl_settlement` (`late_settlement_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The settling payroll month carries the money and its breakdown, so the
-- stored calculation, its payslip and every report read one row.
SET @t = 'payrun_employee_calculation';

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'prior_month_ot_amount') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `prior_month_ot_amount` DECIMAL(12,2) NULL DEFAULT NULL COMMENT ''OT approved after its month locked, settled in this month''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'prior_month_ot') = 0,
  'ALTER TABLE `payrun_employee_calculation` ADD COLUMN `prior_month_ot` JSON NULL COMMENT ''the prior-month OT items: request, date, source month, minutes, rate, amount''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
