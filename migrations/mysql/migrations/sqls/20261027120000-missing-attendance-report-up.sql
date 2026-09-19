-- MISSING ATTENDANCE - two permission keys and ONE new table. Nothing else.
--
-- ADDITIVE ONLY. No existing table is altered, no column is added to one, no
-- index on one is changed and no row in one is written. `new_employee`,
-- `biomax_punch`, `biomax_punch_derived`, `attendance_day_calculation`,
-- `attendance_approval_request`, `attendance_regularized_punch`,
-- `employee_work_shift_assignment`, `work_shift*`, `attendance_monthly_payroll`
-- and every payroll table are UNTOUCHED by this migration. The report derives
-- its rows from data that already exists and stores none of them; the only
-- thing written anywhere is the notification ledger below, which records that
-- a Telegram message was attempted and holds no attendance figure anybody
-- else reads.
--
-- NO BACKFILL. Nobody has been notified, so the absence of a row IS the
-- correct starting state for every employee and every past date.

-- =========================================================== permissions ===
--
-- TWO KEYS, READ AND EXPORT, mirroring `view_raw_attendance` /
-- `export_raw_attendance` on the Attendance List. Taking a spreadsheet of
-- every branch's attendance gaps off the premises is a different decision
-- from looking at the screen.
--
-- GRANTED TO NOBODY. A cross-employee, cross-branch list of one specific
-- attendance defect is a capability rather than a convenience, and a
-- migration is the worst place to decide who has it: it would decide for
-- every designation at once, silently, at deploy time. Administrators
-- (`user_type` 2) reach it through the permission middleware's existing
-- bypass; anybody else is granted it deliberately, by a person, on the
-- Designation rights screen.
--
-- NEITHER KEY SETTLES WHICH BRANCHES. Holding the read key permits the
-- report; the caller's LOCATION scope is resolved separately by
-- `middlewares/dashboard_scope.js` and fails closed, so a branch manager
-- gains no visibility into another branch merely because this report exists.
--
-- `all_permissions` has no unique key on `permission_key`, so each insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_missing_attendance_report' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_missing_attendance_report' );

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'export_missing_attendance_report' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'export_missing_attendance_report' );

-- ==================================================== the notification ledger
--
-- ONE ROW PER (EMPLOYEE, ATTENDANCE DATE), and the UNIQUE KEY is the whole
-- duplicate guard.
--
-- THE RULE IS THE INDEX'S, NOT THE CODE'S. "Has this person already been told
-- about this date?" answered by a SELECT and acted on by a later INSERT is a
-- time-of-check to time-of-use race, and what it races on is somebody's
-- phone: a scheduler retry, two app instances running the same 06:00 cron, or
-- a human re-running the job would each pass the check at the same instant
-- and each send. So the send is CLAIMED by an `INSERT IGNORE` against this
-- key - whoever inserts first owns it, everybody else is told `affectedRows =
-- 0` and skips. See `repository/attendance_missing.js#claim`.
--
-- `status` IS THE OUTCOME, and PENDING is a real state rather than a gap:
-- the row is claimed PENDING before the message is attempted and settled to
-- SENT, FAILED or SKIPPED afterwards. A process that dies mid-send therefore
-- leaves a row that says "we do not know", which is the truth - instead of a
-- SENT row for a message that never left, or no row at all for one that did.
--
-- `punch_count` IS KEPT because it is what the message SAID. The day may be
-- regularized an hour later and its count will then be even; the ledger must
-- still be able to explain what the employee was told at 06:00, and a join
-- back to a recalculated day could not.
--
-- `failure_reason` IS A SHORT CODE THIS CODE PRODUCED, never raw Telegram
-- error text: an error body can carry a chat id or a token fragment, and a
-- ledger is a poor place to keep either.
--
-- TELEGRAM MINI APP READINESS. `employee_id` and `attendance_date` are
-- exactly what a later "Correct Attendance" button needs to open the right
-- employee's right day, and they are already the key of this table. No column
-- is added here for a Mini App that does not exist yet, and none is needed:
-- the handoff is that pair, named once in
-- `usecase/attendance_missing_telegram.js#buildCorrectionTarget`.
--
-- `new_employee` IS REFERENCED BY FOREIGN KEY ONLY. No employee detail is
-- copied here - not a name, not a number, not a chat id that could drift from
-- `employee_telegram_identity`. `telegram_chat_id` is the chat the message
-- was ACTUALLY addressed to, which is a fact about this send and not a
-- contact detail anybody may edit.
CREATE TABLE IF NOT EXISTS `attendance_missing_notification` (
  `attendance_missing_notification_id` INT NOT NULL AUTO_INCREMENT,
  `employee_id`      INT NOT NULL,
  `attendance_date`  DATE NOT NULL,
  `punch_count`      INT NOT NULL COMMENT 'the odd count the message quoted - what the employee was told, not what the day says now',
  `status`           VARCHAR(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | SENT | FAILED | SKIPPED',
  `failure_reason`   VARCHAR(64) NULL DEFAULT NULL COMMENT 'short code produced by this application - never raw provider error text',
  `telegram_chat_id` BIGINT NULL DEFAULT NULL COMMENT 'the private chat this send was addressed to; NULL when the employee has no linked identity',
  `sent_at`          DATETIME NULL DEFAULT NULL,
  `created_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`attendance_missing_notification_id`),
  UNIQUE KEY `uq_amn_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_amn_date_status` (`attendance_date`, `status`),
  CONSTRAINT `fk_amn_employee` FOREIGN KEY (`employee_id`)
    REFERENCES `new_employee` (`employee_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
