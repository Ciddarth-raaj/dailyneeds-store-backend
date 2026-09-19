-- CLOSE ATTENDANCE FOR PAYROLL - the payroll decision to pay on the attendance
-- that exists, and the evidence of what was accepted.
--
-- ================================================== WHAT THIS IS ===========
--
-- At month end payroll cannot wait indefinitely for a missing punch nobody is
-- going to regularize. This records the decision to proceed on the attendance
-- AS IT STANDS for ONE employee and ONE month.
--
-- IT IS NOT AN ATTENDANCE DECISION, and nothing in this migration touches an
-- attendance table. The missing punch is still missing, the regularization
-- request is still pending, the OT request is still undecided, and every one
-- of them keeps its own history and its own approval path. What is recorded
-- here is that PAYROLL accepted the consequences of those things being
-- unresolved - which is a payrun fact, and lives in payrun tables.
--
-- WHY IT CANNOT BE `attendance_monthly_payroll.is_final`. That column is
-- DERIVED, not decided: `utils/attendance_payroll.js` computes it as
-- `heldDates.length === 0` on every run and the row is upserted in place. A
-- close written there would be silently recomputed away by the next attendance
-- calculation, and it would also be a lie about what attendance knows.
--
-- ====================================== WHY THE FIGURES ARE COPIED =========
--
-- The audit table below stores the attendance figures payroll accepted, and
-- not only a reference to the row they came from. `attendance_monthly_payroll`
-- is written with INSERT ... ON DUPLICATE KEY UPDATE, so the row a reference
-- points at MUTATES when the engine re-runs: same id, bumped version,
-- different numbers. A reference alone would answer "which row" and never
-- "what did payroll actually accept", which is the only question this audit
-- exists to answer. The reference columns are stored as well, so the accepted
-- basis and the live row can always be compared.
--
-- ============================================== APPEND ONLY ================
--
-- The audit table is written and never updated or deleted. There is no reopen
-- in this change, and inventing one silently is exactly what an append-only
-- log is for preventing.

-- ------------------------------------------- 1. the state, on the snapshot
-- THREE COLUMNS ON `payrun_employee`, which is already keyed
-- (period_year, period_month, employee_id) by `uq_payrun_employee_month` -
-- one row per employee per month, which is exactly the grain of this decision.
-- They live here rather than in a table of their own so that the month read -
-- one batched query for three hundred employees - needs no extra join to know
-- whether somebody's attendance was closed.
SET @add_closed = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee'
      AND `COLUMN_NAME` = 'attendance_closed_for_payroll') = 0,
  'ALTER TABLE `payrun_employee` ADD COLUMN `attendance_closed_for_payroll` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''payroll accepted the attendance as it stood. NOT an attendance verdict''',
  'DO 0');
PREPARE stmt FROM @add_closed; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_closed_by = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee'
      AND `COLUMN_NAME` = 'attendance_closed_by') = 0,
  'ALTER TABLE `payrun_employee` ADD COLUMN `attendance_closed_by` INT NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @add_closed_by; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_closed_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee'
      AND `COLUMN_NAME` = 'attendance_closed_at') = 0,
  'ALTER TABLE `payrun_employee` ADD COLUMN `attendance_closed_at` TIMESTAMP NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @add_closed_at; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ------------------------------------------- 2. the evidence, append only
CREATE TABLE IF NOT EXISTS `payrun_attendance_close_audit` (
  `payrun_attendance_close_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,

  -- WHO DECIDED, AND WHEN. The act is a person's; `closed_by` is the server's
  -- identity for them, never anything a request body supplied.
  `closed_by` INT NULL DEFAULT NULL,
  `closed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- --------------------------------------- the basis payroll accepted
  -- WHICH ATTENDANCE ROW, and which version of it. Kept so the accepted basis
  -- can be compared against the live row later; NOT sufficient on its own,
  -- for the reason in the header.
  `attendance_monthly_payroll_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `attendance_payroll_version`    INT NULL DEFAULT NULL,
  `attendance_calculated_at`      TIMESTAMP(3) NULL DEFAULT NULL,

  -- WAS ATTENDANCE ACTUALLY FINAL AT THE MOMENT OF THE CLOSE. Usually 0 - that
  -- is why somebody closed it - but a close of an already-final month is legal
  -- and this is what tells the two apart afterwards.
  `attendance_was_final` TINYINT(1) NOT NULL DEFAULT 0,

  -- THE FIGURES, COPIED. See the header for why a reference is not enough.
  `salary_days`              INT NULL DEFAULT NULL,
  `extra_days`               INT NULL DEFAULT NULL,
  `shortage_minutes`         INT NULL DEFAULT NULL,
  `missing_minute_deduction` DECIMAL(12,2) NULL DEFAULT NULL,
  `approved_ot_minutes`      INT NULL DEFAULT NULL,

  -- THE OT RATE BASIS. One NRM is the ordinary case; `ot_groups` is the honest
  -- account when the month's overtime was worked against several.
  `effective_nrm_minutes` INT NULL DEFAULT NULL,
  `effective_nrm_source`  VARCHAR(32) NULL DEFAULT NULL,
  `ot_groups`             JSON NULL COMMENT 'per-NRM OT split accepted at close',

  -- --------------------------------------- what was STILL unresolved
  -- THE POINT OF THE RECORD. Six months later, "why was this person paid 24
  -- days" is answered by these three columns and not by anybody's memory.
  `held_dates`                JSON NULL COMMENT 'dates the engine had not settled, named',
  `pending_regularizations`   INT NOT NULL DEFAULT 0,
  `pending_ot`                INT NOT NULL DEFAULT 0,

  PRIMARY KEY (`payrun_attendance_close_audit_id`),
  KEY `idx_pac_month_employee` (`period_year`, `period_month`, `employee_id`),
  KEY `idx_pac_payrun_employee` (`payrun_employee_id`),
  CONSTRAINT `fk_pac_payrun_employee`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only: payroll accepted this attendance basis, with what was unresolved';

-- ------------------------------------------------- 3. the permission key
-- CLOSING ATTENDANCE FOR PAYROLL IS ITS OWN DECISION, and its own key.
--
-- NOT `process_payroll`: that key enters incentives and calculates, and every
-- holder of it would silently gain the power to waive an attendance gate that
-- has salary consequences.
--
-- NOT `approve_payrun`: this repository separates proposing from approving
-- wherever money is concerned - `add_salary` and `approve_salary_revision` are
-- two keys for exactly that reason - and one person who could both waive the
-- gate and sign the month off is that separation undone.
--
-- So: the processor prepares the month, somebody holding THIS key accepts the
-- attendance basis, and the approver signs it. Granted to NOBODY here, so it
-- reaches people only by a deliberate grant on the rights screen;
-- administrators keep the existing user_type 2 bypass.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
    SELECT 'close_payrun_attendance' AS `permission_key`
  ) k
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key` );
