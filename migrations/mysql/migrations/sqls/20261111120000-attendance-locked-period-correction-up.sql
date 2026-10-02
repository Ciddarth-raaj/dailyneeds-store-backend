-- =====================================================================
-- Locked-period attendance correction.
--
-- A regularization on a date whose payroll month is APPROVED_LOCKED may be
-- corrected - one employee, one date, one request - only after a holder of
-- `correct_locked_attendance` authorises the exception, with a reason. The
-- month stays locked; `payrun_employee_calculation` is never touched; the
-- corrected day row is written inside the request's own decision transaction
-- and the payroll difference is recorded here for MANUAL settlement.
--
--   attendance_locked_period_authorisation   one row per request:
--     REQUIRED    raised in a locked month, waiting for authorisation
--     AUTHORISED  a key holder authorised it; the chain may proceed
--     APPLIED     the final approval wrote the corrected day
--     REVOKED     an authorised revoke withdrew it
--
--   attendance_locked_period_correction_event   one row per write to the
--     locked day (final approval, revoke). Its calculation and difference
--     columns are written once and never updated; only the settlement
--     columns move, once, PENDING_ADJUSTMENT -> SETTLED, guarded on state.
--     Never deleted by the application (RESTRICT).
-- =====================================================================

CREATE TABLE IF NOT EXISTS `attendance_locked_period_authorisation` (
  `attendance_locked_period_authorisation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `employee_id`      INT NOT NULL,
  `attendance_date`  DATE NOT NULL,
  `period_year`      SMALLINT NOT NULL,
  `period_month`     TINYINT NOT NULL,
  `status`           ENUM('REQUIRED','AUTHORISED','APPLIED','REVOKED') NOT NULL DEFAULT 'REQUIRED',
  `required_at`      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `authorised_by_employee_id` INT NULL,
  `authorised_by_user_id`     INT NULL,
  `authorisation_reason`      VARCHAR(500) NULL,
  `authorised_at`             TIMESTAMP(3) NULL,
  `updated_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_locked_period_authorisation_id`),
  UNIQUE KEY `uq_alpa_request` (`attendance_approval_request_id`),
  KEY `idx_alpa_employee_date` (`employee_id`, `attendance_date`),
  CONSTRAINT `fk_alpa_request` FOREIGN KEY (`attendance_approval_request_id`)
    REFERENCES `attendance_approval_request` (`attendance_approval_request_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `attendance_locked_period_correction_event` (
  `attendance_locked_period_correction_event_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_locked_period_authorisation_id` BIGINT UNSIGNED NOT NULL,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `employee_id`      INT NOT NULL,
  `attendance_date`  DATE NOT NULL,
  `event_type`       ENUM('APPROVAL','REVOKE') NOT NULL,
  `actor_employee_id` INT NULL,
  `actor_user_id`     INT NULL,
  `event_reason`     VARCHAR(500) NULL COMMENT 'the revoke reason, NULL on an approval',
  `occurred_at`      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- The authorisation, copied so the event reads on its own.
  `authorised_by_employee_id` INT NULL,
  `authorisation_reason`      VARCHAR(500) NULL,
  `authorised_at`             TIMESTAMP(3) NULL,
  -- The frozen payroll it was priced against.
  `payrun_calculation_id`   BIGINT UNSIGNED NULL,
  `payrun_calculation_hash` CHAR(32) NULL,
  `frozen_net_pay`          DECIMAL(12,2) NULL,
  `old_calculation`  JSON NOT NULL,
  `new_calculation`  JSON NOT NULL,
  `payroll_difference` JSON NOT NULL COMMENT 'priced components, see utils/attendance_locked_correction.js',
  `net_difference`   DECIMAL(12,2) NOT NULL COMMENT '> 0 payable to the employee, < 0 recoverable',
  `direction`        ENUM('PAYABLE_TO_EMPLOYEE','RECOVERABLE_FROM_EMPLOYEE','NO_DIFFERENCE') NOT NULL,
  `statutory_recomputed` TINYINT(1) NOT NULL DEFAULT 0,
  -- Manual settlement, by Payroll, in a later month.
  `adjustment_status` ENUM('PENDING_ADJUSTMENT','SETTLED','NOT_REQUIRED') NOT NULL,
  `applied_by`            INT NULL,
  `applied_at`            TIMESTAMP(3) NULL,
  `applied_note`          VARCHAR(500) NULL,
  `applied_payroll_year`  SMALLINT NULL,
  `applied_payroll_month` TINYINT NULL,
  PRIMARY KEY (`attendance_locked_period_correction_event_id`),
  KEY `idx_alpce_authorisation` (`attendance_locked_period_authorisation_id`),
  KEY `idx_alpce_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_alpce_adjustment` (`adjustment_status`),
  CONSTRAINT `fk_alpce_authorisation` FOREIGN KEY (`attendance_locked_period_authorisation_id`)
    REFERENCES `attendance_locked_period_authorisation` (`attendance_locked_period_authorisation_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'correct_locked_attendance' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'correct_locked_attendance');
