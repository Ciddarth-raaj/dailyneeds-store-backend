-- Payrun Calculation & Review - Reset Calculation.
--
-- ADDITIVE ONLY. One new append-only table. No existing table is altered, no
-- existing row is written, and no permission key is added: resetting reuses
-- `process_payroll`, the key that calculates and recalculates, because a reset
-- discards exactly what that key can already overwrite - and nothing more.
--
-- WHAT A RESET IS. "Not Calculated" is the ABSENCE of a row in
-- `payrun_employee_calculation` for (year, month, employee) - see
-- `utils/payrun_calculation.js#deriveStatus`. So a reset deletes that one row,
-- inside a transaction that has it `FOR UPDATE`, and only while its stored
-- status is still `CALCULATED`. An APPROVED_LOCKED row is never removed, and
-- the guard is an ALLOW-list: any stored status added later (a paid or
-- published state) is refused by the same predicate without a code change.
--
-- NOTHING ELSE MOVES. The snapshot (`payrun_employee`), the adjustments and
-- their confirmation, the monthly pay type, the attendance close, the
-- calculation audit log, the Salary Master, the Employee Master, attendance,
-- punches and every request table are untouched; nothing references a
-- calculation row by foreign key, so its removal cascades nowhere.
--
-- WHY A TABLE OF ITS OWN rather than a RESET verb on
-- `payrun_employee_calculation_audit`. That log's `action` is an ENUM on a
-- table holding payroll audit, and widening it is an ALTER nobody wants to run
-- there. A reset also carries facts no other act has - the reason, the remark,
-- individual or bulk, the status it was in - and THE WHOLE ROW IT REMOVED, so
-- "what did this employee's month say before it was reset" stays answerable.
CREATE TABLE IF NOT EXISTS `payrun_employee_calculation_reset_audit` (
  `payrun_calculation_reset_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,

  -- The removed row's id. No foreign key: the row it names no longer exists.
  `payrun_calculation_id` BIGINT UNSIGNED NOT NULL,

  -- The status the screen showed (READY_FOR_APPROVAL, RECALCULATION_REQUIRED,
  -- ...) and the stored one beneath it, which is always CALCULATED.
  `previous_status`        VARCHAR(32) NOT NULL,
  `previous_stored_status` VARCHAR(32) NOT NULL,

  `reset_reason` ENUM(
    'ATTENDANCE_CORRECTED','SALARY_MASTER_CORRECTED',
    'WRONG_OT','WRONG_ADDITION_DEDUCTION','OTHER'
  ) NOT NULL,
  `reset_remark` VARCHAR(500) NULL DEFAULT NULL,
  `reset_mode`   ENUM('INDIVIDUAL','BULK') NOT NULL,

  -- What the removed calculation said, in columns for querying...
  `calculation_version`  INT NULL DEFAULT NULL,
  `calculation_revision` INT NULL DEFAULT NULL,
  `calculation_hash`     CHAR(32) NULL DEFAULT NULL,
  `source_hash`          CHAR(32) NULL DEFAULT NULL,
  `inputs_hash`          CHAR(32) NULL DEFAULT NULL,
  `net_pay`              DECIMAL(12,2) NULL DEFAULT NULL,
  -- ...and in full, so nothing the reset removed is unrecoverable.
  `calculation_snapshot` JSON NOT NULL,

  `reset_by` INT NULL DEFAULT NULL,
  `reset_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_calculation_reset_audit_id`),
  KEY `idx_payrun_calc_reset_employee_month` (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_calc_reset_payrun` (`payrun_employee_id`),
  -- "Other" means nothing without the remark that explains it.
  CONSTRAINT `chk_payrun_calc_reset_other_remark`
    CHECK (`reset_reason` <> 'OTHER' OR (`reset_remark` IS NOT NULL AND CHAR_LENGTH(TRIM(`reset_remark`)) > 0)),
  CONSTRAINT `fk_payrun_calc_reset_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only: one row per employee calculation reset, with the row it removed';
