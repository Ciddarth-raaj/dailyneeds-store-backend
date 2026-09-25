-- =====================================================================
-- Admin "Revoke Approval" for Attendance Regularization and OT: the AUDIT.
--
-- A revocation reopens an existing request at one stage: that step and every
-- later step go back to PENDING, the request goes back to PENDING, and the
-- day is recalculated - all in one transaction
-- (`repository/attendance_regularization.js#revokeStage`). Resetting the step
-- rows clears who decided them and when, so THIS TABLE is where that history
-- survives: one row per revocation, written in the same transaction, never
-- updated and never deleted by the application.
--
-- WHAT A ROW HOLDS
--   the request as it stood (status, stage, finalization, approved OT, when
--   it was decided), the revoked stage's ORIGINAL decision in its own columns
--   (decision, by whom, when, remarks, override flag, source), and in
--   `reset_steps` EVERY step the revocation reset - the revoked one and all
--   later ones - with their original decision fields, because a later
--   stage's decision is voided by revoking an earlier one and must not simply
--   vanish.
--
-- NOT A PERMISSION KEY. Revoking is for administrators (`user_type` 2) only
-- and is checked on the account type directly, exactly as Attendance
-- Required and Duty Location are: nothing a designation can be granted
-- reaches it. So this migration inserts no permission.
--
-- ADDITIVE ONLY. No existing table or column is altered and no row of any
-- existing table is written.
-- =====================================================================
CREATE TABLE IF NOT EXISTS `attendance_approval_revocation` (
  `attendance_approval_revocation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `request_type` VARCHAR(32) NOT NULL COMMENT 'as stored on the request: REGULARIZATION, REGULARIZATION_WITH_OT or OT',
  `requested_for_employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,

  -- THE REVOKED STAGE and its ORIGINAL decision.
  `revoked_stage_no` INT NOT NULL,
  `revoked_approver_role` VARCHAR(32) NULL,
  `revoked_approval_level` VARCHAR(16) NULL,
  `revoked_step_approver_employee_id` INT NULL COMMENT 'the approver the stage is addressed to (employee-level chains)',
  `original_decision` ENUM('APPROVED','REJECTED') NOT NULL,
  `original_decided_by_employee_id` INT NULL,
  `original_decided_at` TIMESTAMP(3) NULL,
  `original_remarks` VARCHAR(500) NULL,
  `original_acted_as_admin_override` TINYINT(1) NOT NULL DEFAULT 0,
  `original_decision_source` VARCHAR(16) NULL,

  -- THE REQUEST as it stood before the revocation.
  `original_request_status` VARCHAR(16) NOT NULL,
  `original_current_stage_no` INT NOT NULL,
  `original_finalization_state` VARCHAR(16) NULL,
  `original_approved_ot_minutes` INT NULL,
  `original_request_decided_at` TIMESTAMP(3) NULL,

  -- EVERY step reset by this revocation (the revoked one and every later
  -- one), each with its original decision fields.
  `reset_steps` JSON NOT NULL,

  -- WHO, WHEN, WHY.
  `revoked_by_employee_id` INT NULL COMMENT 'NULL for an administrator account with no employee record',
  `revoked_by_user_id` INT NULL,
  `revoked_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reason` VARCHAR(500) NOT NULL COMMENT 'mandatory, entered by the administrator',
  `calculations_written` INT NOT NULL DEFAULT 0 COMMENT 'attendance_day_calculation rows rewritten in the same transaction',

  PRIMARY KEY (`attendance_approval_revocation_id`),
  KEY `idx_aarev_request` (`attendance_approval_request_id`),
  KEY `idx_aarev_employee_date` (`requested_for_employee_id`, `attendance_date`),
  KEY `idx_aarev_revoked_at` (`revoked_at`),
  CONSTRAINT `fk_aarev_request` FOREIGN KEY (`attendance_approval_request_id`)
    REFERENCES `attendance_approval_request` (`attendance_approval_request_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
