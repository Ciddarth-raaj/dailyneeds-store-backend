-- Attendance Approver Setup - the EMPLOYEE-LEVEL approval chain.
--
-- ADDITIVE ONLY. Two new tables, three nullable columns appended to the
-- existing approval tables, one appended ENUM value, one permission key
-- granted to NOBODY. No existing column is modified or dropped, no existing
-- row is rewritten, no grant is revoked. `biomax_punch` is not touched.
--
-- WHAT IT ADDS. Each employee may carry a First Level, a Second Level and a
-- Final Approver, all as EMPLOYEE IDS (names are read from `new_employee`
-- at display time, never stored here). First and Second are optional; Final
-- is mandatory once a row exists. A request raised for a MAPPED employee
-- snapshots the actual approver ids onto its steps; an UNMAPPED employee
-- keeps the existing designation/outlet chain untouched, so mappings can be
-- created gradually.
--
-- THE STEP GAINS THE PERSON. `attendance_approval_step.approver_employee_id`
-- is the snapshotted approver of that stage and `approval_level` says which
-- of the three levels it was. Both are NULL on every historical role-based
-- step, which continues to read and to be decided exactly as before. The
-- new ENUM value 'EMPLOYEE' on `approver_role` marks a step addressed to a
-- person rather than to a role; appending a value to an ENUM is a metadata
-- change and rewrites no row.
--
-- THE AUDIT IS APPEND-ONLY. Every change to an approver - SET on one
-- employee, BULK_SET across many, REPLACE of one approver by another,
-- including the reassignment of an undecided pending step - writes a row
-- here and nothing here is ever updated or deleted by the application.

-- ============================================== 1. the approver master ====
CREATE TABLE IF NOT EXISTS `attendance_approver_setup` (
  `attendance_approver_setup_id` INT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL COMMENT 'new_employee.employee_id whose requests this chain approves',
  `first_level_approver_employee_id`  INT NULL COMMENT 'optional',
  `second_level_approver_employee_id` INT NULL COMMENT 'optional',
  `final_approver_employee_id`        INT NOT NULL COMMENT 'mandatory - the final authority',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` INT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` INT NULL,
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_approver_setup_id`),
  UNIQUE KEY `uq_aas_employee` (`employee_id`),
  KEY `idx_aas_first`  (`first_level_approver_employee_id`),
  KEY `idx_aas_second` (`second_level_approver_employee_id`),
  KEY `idx_aas_final`  (`final_approver_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================== 2. the audit, append-only ==
CREATE TABLE IF NOT EXISTS `attendance_approver_setup_audit` (
  `attendance_approver_setup_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL COMMENT 'the affected employee (whose chain changed)',
  `approval_level` ENUM('FIRST','SECOND','FINAL') NOT NULL,
  `old_approver_employee_id` INT NULL,
  `new_approver_employee_id` INT NULL,
  `action_type` ENUM('SET','BULK_SET','REPLACE') NOT NULL,
  `attendance_approval_request_id` BIGINT UNSIGNED NULL COMMENT 'set when a pending request step was reassigned by REPLACE',
  `attendance_approval_step_id`    BIGINT UNSIGNED NULL COMMENT 'the reassigned step, when any',
  `changed_by` INT NULL,
  `changed_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_approver_setup_audit_id`),
  KEY `idx_aasa_employee` (`employee_id`, `changed_at`),
  KEY `idx_aasa_request` (`attendance_approval_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================== 3. the step snapshot =======
ALTER TABLE `attendance_approval_step`
  ADD COLUMN `approver_employee_id` INT NULL DEFAULT NULL
    COMMENT 'employee-level chain: the snapshotted approver of this stage. NULL on role-based steps';
ALTER TABLE `attendance_approval_step`
  ADD COLUMN `approval_level` ENUM('FIRST','SECOND','FINAL') NULL DEFAULT NULL
    COMMENT 'employee-level chain: which configured level this stage was. NULL on role-based steps';
ALTER TABLE `attendance_approval_step`
  ADD INDEX `idx_aas_approver_employee` (`approver_employee_id`, `decision`);
ALTER TABLE `attendance_approval_step`
  MODIFY COLUMN `approver_role` ENUM('STORE_MANAGER','OPERATIONS_MANAGER','HR','ADMIN','EMPLOYEE') NOT NULL;

ALTER TABLE `attendance_approval_request`
  ADD COLUMN `chain_source` ENUM('ROLE','EMPLOYEE') NULL DEFAULT NULL
    COMMENT 'which chain was snapshotted at creation. NULL on requests raised before this feature (role-based)';

-- ========================================================== permission ====
--   manage_attendance_approvers   the Attendance Approver Setup screen and
--                                 every mutation API behind it.     NOBODY
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_attendance_approvers' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_approvers');
