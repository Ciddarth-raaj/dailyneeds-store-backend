-- Full & Final Settlement, Exit Interview and Rehire Eligibility.
--
-- ADDITIVE ONLY. New tables for the exit case, settlement history, exit
-- interview, rehire assessments / exceptions and exit reconciliation; one
-- defaulted column on the payslip; permission keys granted to NOBODY. No
-- existing row is recalculated, republished, unlocked or moved, and no payroll
-- calculation column is added: every existing payslip gets
-- document_type = 'PAYSLIP', which is what it already is.
--
-- Every statement is guarded so the file can be re-run without error.

-- ======================================== 3. WHICH DOCUMENT WAS PUBLISHED
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_payslip'
                  AND `COLUMN_NAME` = 'document_type') = 0,
  'ALTER TABLE `payrun_payslip` ADD COLUMN `document_type` ENUM(''PAYSLIP'',''FNF'') NOT NULL DEFAULT ''PAYSLIP'' COMMENT ''a Salary Payslip, or a Full & Final Settlement statement'' AFTER `template_version`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ===================================================== 4. THE EXIT CASE
--
-- ONE ROW PER EXIT EVENT: an employee and the last working day that ended an
-- employment spell. The F&F settlement status, the exit interview and the
-- rehire assessments all hang off this row, so each stays with the exit it
-- belongs to.
--
-- A REJOIN NEVER TOUCHES IT. Rejoining opens a new employment period and
-- clears `new_employee.resignation_date`; the next resignation is a different
-- date and so a different row. `uq_fnf_exit` is what makes a second F&F for
-- the SAME exit impossible, and what lets a legitimate later one exist.
--
-- `period_id` links the closed `employee_employment_period` when it can be
-- found (ended_on = exit_date); it is nullable because the lifecycle data may
-- disagree with the master, and the case must not be refused for that.
--
-- `payrun_employee_id` is the payrun month the F&F was calculated and
-- published in, recorded when it is settled. Unique: one month settles one
-- exit.
CREATE TABLE IF NOT EXISTS `employee_fnf_settlement` (
  `fnf_settlement_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `exit_date` DATE NOT NULL COMMENT 'last working day',
  `period_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `status` ENUM('PENDING','SETTLED') NOT NULL DEFAULT 'PENDING',
  `payrun_employee_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `period_year`  SMALLINT NULL DEFAULT NULL,
  `period_month` TINYINT NULL DEFAULT NULL,
  -- WHAT WAS PAID: a REFERENCE to the published payroll document and the
  -- calculation it was frozen from. No amount is stored here - the net pay is
  -- read from that document's frozen snapshot, the single source of truth.
  `settled_payslip_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `settled_calculation_hash` CHAR(32) NULL DEFAULT NULL,
  `payment_mode` ENUM('BANK','CASH') NULL DEFAULT NULL,
  `payment_reference` VARCHAR(100) NULL DEFAULT NULL,
  `paid_on` DATE NULL DEFAULT NULL,
  `settled_by` INT NULL DEFAULT NULL,
  `settled_at` TIMESTAMP NULL DEFAULT NULL,
  `created_by` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`fnf_settlement_id`),
  UNIQUE KEY `uq_fnf_exit` (`employee_id`, `exit_date`),
  UNIQUE KEY `uq_fnf_payrun` (`payrun_employee_id`),
  KEY `idx_fnf_status` (`status`),
  KEY `idx_fnf_period` (`period_id`),
  CONSTRAINT `fk_fnf_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`),
  CONSTRAINT `fk_fnf_period`
    FOREIGN KEY (`period_id`) REFERENCES `employee_employment_period` (`period_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='one row per exit event: F&F settlement completion, anchor for interview and rehire';

-- Append-only: every Settle and Reopen, with who, when, why and the figures.
CREATE TABLE IF NOT EXISTS `employee_fnf_settlement_event` (
  `fnf_settlement_event_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fnf_settlement_id` BIGINT UNSIGNED NOT NULL,
  `event_type` ENUM('SETTLED','REOPENED') NOT NULL,
  `payrun_employee_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `payslip_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `calculation_hash` CHAR(32) NULL DEFAULT NULL,
  `payment_mode` ENUM('BANK','CASH') NULL DEFAULT NULL,
  `payment_reference` VARCHAR(100) NULL DEFAULT NULL,
  `paid_on` DATE NULL DEFAULT NULL,
  `reason` VARCHAR(500) NULL DEFAULT NULL,
  `actor_employee_id` INT NULL DEFAULT NULL,
  `actor_user_id` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`fnf_settlement_event_id`),
  KEY `idx_fnf_event_settlement` (`fnf_settlement_id`),
  CONSTRAINT `fk_fnf_event_settlement`
    FOREIGN KEY (`fnf_settlement_id`) REFERENCES `employee_fnf_settlement` (`fnf_settlement_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only history of F&F settlement completion';

-- ============================================== 5. THE EXIT INTERVIEW
--
-- CONFIDENTIAL. One per exit case. Read only with view_exit_interview; never
-- copied into a payslip snapshot, the Mini App or a Telegram message.
CREATE TABLE IF NOT EXISTS `employee_exit_interview` (
  `exit_interview_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fnf_settlement_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `interview_date` DATE NOT NULL,
  `primary_reason` ENUM('BETTER_OPPORTUNITY','COMPENSATION','WORK_ENVIRONMENT','MANAGER_RELATIONSHIP',
                        'WORKING_HOURS','PERSONAL_FAMILY','RELOCATION','HEALTH','HIGHER_STUDIES',
                        'TERMINATED','ABSCONDED','OTHER') NOT NULL,
  `rating_job_satisfaction` TINYINT NULL DEFAULT NULL,
  `rating_manager_support`  TINYINT NULL DEFAULT NULL,
  `rating_work_environment` TINYINT NULL DEFAULT NULL,
  `rating_compensation`     TINYINT NULL DEFAULT NULL,
  `would_recommend` ENUM('YES','NO') NULL DEFAULT NULL,
  `would_return`    ENUM('YES','NO') NULL DEFAULT NULL,
  `feedback`    VARCHAR(1000) NULL DEFAULT NULL,
  `suggestions` VARCHAR(1000) NULL DEFAULT NULL,
  `revision` INT NOT NULL DEFAULT 1,
  `recorded_by` INT NULL DEFAULT NULL,
  `recorded_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` INT NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`exit_interview_id`),
  UNIQUE KEY `uq_exit_interview_case` (`fnf_settlement_id`),
  KEY `idx_exit_interview_employee` (`employee_id`),
  CONSTRAINT `fk_exit_interview_case`
    FOREIGN KEY (`fnf_settlement_id`) REFERENCES `employee_fnf_settlement` (`fnf_settlement_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='CONFIDENTIAL: one short exit interview per exit event';

-- ========================================== 6. REHIRE ELIGIBILITY HISTORY
--
-- APPEND-ONLY. The current assessment of an exit is its newest row; an
-- override is a new row with a reason, so every earlier decision survives.
CREATE TABLE IF NOT EXISTS `employee_rehire_assessment` (
  `rehire_assessment_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fnf_settlement_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `eligibility` ENUM('YES','NO','CONDITIONAL') NOT NULL,
  `conditions` VARCHAR(500) NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `is_override` TINYINT(1) NOT NULL DEFAULT 0,
  `override_reason` VARCHAR(500) NULL DEFAULT NULL,
  `assessed_by` INT NULL DEFAULT NULL,
  `assessed_by_user` INT NULL DEFAULT NULL,
  `assessed_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`rehire_assessment_id`),
  KEY `idx_rehire_case` (`fnf_settlement_id`, `rehire_assessment_id`),
  KEY `idx_rehire_employee` (`employee_id`),
  CONSTRAINT `fk_rehire_case`
    FOREIGN KEY (`fnf_settlement_id`) REFERENCES `employee_fnf_settlement` (`fnf_settlement_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='CONFIDENTIAL: append-only fit-for-rehire assessments per exit event';

-- ========================== 6b. REHIRE EXCEPTIONS AT REJOIN (append-only)
--
-- A rejoin from an exit assessed NO or CONDITIONAL needs management approval
-- (approve_rehire_exception) and a reason; the approval is written here in
-- the SAME transaction as the rejoin. The assessment itself is never edited.
CREATE TABLE IF NOT EXISTS `employee_rehire_exception` (
  `employee_rehire_exception_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fnf_settlement_id` BIGINT UNSIGNED NOT NULL,
  `rehire_assessment_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `eligibility` ENUM('NO','CONDITIONAL') NOT NULL,
  `conditions` VARCHAR(500) NULL DEFAULT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `rejoin_date` DATE NOT NULL,
  `approved_by` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_rehire_exception_id`),
  KEY `idx_rehire_exception_employee` (`employee_id`),
  CONSTRAINT `fk_rehire_exception_case`
    FOREIGN KEY (`fnf_settlement_id`) REFERENCES `employee_fnf_settlement` (`fnf_settlement_id`),
  CONSTRAINT `fk_rehire_exception_assessment`
    FOREIGN KEY (`rehire_assessment_id`) REFERENCES `employee_rehire_assessment` (`rehire_assessment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='CONFIDENTIAL: management approvals to rejoin despite a NO / CONDITIONAL rehire assessment';

-- ================================== 7. EXIT RECONCILIATION (append-only)
--
-- A resignation recorded after a month was initialized is brought into that
-- month's snapshot by an explicit, audited action - the old and the new
-- `payrun_employee.resignation_date`, who, when. No figure is written.
CREATE TABLE IF NOT EXISTS `payrun_exit_reconcile_audit` (
  `payrun_exit_reconcile_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL,
  `employee_id`  INT NOT NULL,
  `old_resignation_date` DATE NULL DEFAULT NULL,
  `new_resignation_date` DATE NULL DEFAULT NULL,
  `actor_employee_id` INT NULL DEFAULT NULL,
  `actor_user_id` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`payrun_exit_reconcile_audit_id`),
  KEY `idx_exit_reconcile_employee` (`period_year`, `period_month`, `employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only: exit dates reconciled into an initialized payrun month';

-- ======================================================= 8. PERMISSIONS
-- Declared, granted to NOBODY. Administrators hold them through user_type 2.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_fnf_settlement' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_fnf_settlement');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'confirm_fnf_payment' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'confirm_fnf_payment');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_exit_interview' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_exit_interview');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_exit_interview' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_exit_interview');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'override_rehire_eligibility' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'override_rehire_eligibility');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_rehire_exception' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_rehire_exception');
