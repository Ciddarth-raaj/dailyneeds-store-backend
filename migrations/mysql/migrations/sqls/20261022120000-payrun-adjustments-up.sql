-- Payrun Adjustments V1 - the money that is added to, or taken off, a month
-- that has already been initialized.
--
-- ADDITIVE ONLY. Three new tables and NO new permission key. No existing table
-- is altered, no existing row is written, and nothing here reads or changes
-- `payrun_employee`, `employee_salary`, `new_employee` or any attendance
-- table: this migration creates the place an adjustment is recorded and
-- nothing that records one.
--
-- WHAT AN ADJUSTMENT IS NOT. It is not a salary revision - that is
-- `employee_salary`, effective-dated and approved. It is not attendance. It is
-- a one-month amount against ONE INITIALIZED employee, and the fact that it
-- hangs off `payrun_employee` rather than off `new_employee` is the whole
-- rule: an employee with no snapshot for the month has no month to adjust.
--
-- THE POPULATION IS NEVER FROZEN HERE. There is no "adjustment run" row, no
-- exported-batch table and no snapshot of who was initialized when somebody
-- downloaded a template. Completion is computed every time it is asked for,
-- from whoever is initialized RIGHT NOW - so three employees initialized after
-- the other two hundred and twenty were finished appear as pending by
-- themselves, without anything being re-opened. A batch table would have made
-- that impossible, which is why there is not one.
--
-- Every statement is guarded so the whole file can be re-run without error,
-- exactly as the payrun initialization migration is.

-- ========================================== 1. The component amounts
--
-- NORMALIZED - ONE ROW PER COMPONENT, not six columns on one row. V1 is
-- deliberately a fixed list of six, and a wide table would have been shorter
-- to write; the normalized shape is chosen because each amount carries its own
-- history (who entered it, when, from a file or by hand) and because the
-- calculation contract reads components by KIND - additions, deductions,
-- informational - rather than by name. A seventh component then costs an enum
-- value rather than a schema change on a payroll table.
--
-- THE ENUM IS THE WHOLE OF V1, AND IT IS CLOSED. Loan Recovery, Other Addition
-- and Other Deduction are deliberately absent: a generic component is a
-- component nobody can price, and "Other Deduction: 4,000" on a payslip is an
-- argument rather than an explanation. The database refusing an unknown value
-- is what stops an import inventing one - see the import's column check, which
-- refuses the FILE, but this is the floor under it.
--
--   INCENTIVE, BONUS, ARREARS     additions to net pay. PF: no. ESI: no.
--   ADVANCE_RECOVERY,             deductions from NET PAY only. They do not
--   SHORTAGE_RECOVERY             reduce PF or ESI wages - recovering money
--                                 somebody was already paid is not a change to
--                                 what they earned.
--   BALANCE_ADVANCE               INFORMATIONAL. Zero effect on gross, earned
--                                 gross, net pay, PF and ESI. It is stored
--                                 here so a payslip can later print the
--                                 employee's remaining advance balance, and it
--                                 is in the same table as the rest because it
--                                 is entered on the same row of the same sheet
--                                 by the same person. What makes it inert is
--                                 `utils/payrun_adjustments.js`, which is the
--                                 ONE place that says what a component does.
--
-- AMOUNTS ARE NON-NEGATIVE, AND THE SIGN IS THE COMPONENT'S JOB. Advance
-- Recovery 500 means 500 comes off; it is never stored as -500. A column that
-- accepted both signs would mean a negative recovery is an addition nobody
-- named, and two places would decide what a minus sign means. The CHECK is
-- advisory on MySQL 5.7 (parsed and ignored) and enforced from 8.0; the
-- application refuses a negative amount regardless, and a test proves it.
--
-- ONE ROW PER EMPLOYEE PER MONTH PER COMPONENT, ENFORCED BY THE DATABASE. The
-- unique key is what makes a re-import idempotent: two browser tabs, or a
-- second upload of the same file, update the one row rather than producing a
-- second Incentive nobody can see behind the first.
CREATE TABLE IF NOT EXISTS `payrun_employee_adjustment` (
  `payrun_adjustment_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,

  `component` ENUM(
    'INCENTIVE','BONUS','ARREARS',
    'ADVANCE_RECOVERY','SHORTAGE_RECOVERY',
    'BALANCE_ADVANCE'
  ) NOT NULL,

  `amount` DECIMAL(12,2) NOT NULL,

  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` INT NULL DEFAULT NULL,

  PRIMARY KEY (`payrun_adjustment_id`),
  UNIQUE KEY `uq_payrun_adjustment_component`
    (`period_year`, `period_month`, `employee_id`, `component`),
  KEY `idx_payrun_adjustment_month` (`period_year`, `period_month`),
  KEY `idx_payrun_adjustment_payrun` (`payrun_employee_id`),
  CONSTRAINT `chk_payrun_adjustment_amount` CHECK (`amount` >= 0),
  CONSTRAINT `fk_payrun_adjustment_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================= 2. The per-employee state for the month
--
-- WHAT THIS TABLE IS FOR, IN ONE SENTENCE: it is where an EXPLICIT "this
-- person has no adjustment this month" is recorded, and it exists because the
-- absence of a row in the table above cannot say that.
--
-- A BLANK CELL IS NOT A CONFIRMATION, AND THAT IS THE POINT OF THE WHOLE
-- FEATURE. Somebody who uploads a template with two hundred empty rows has
-- said nothing about two hundred employees; they have uploaded a file. If
-- blank meant "confirmed none", then the person who filled in three rows and
-- imported would have silently signed off on the other two hundred and
-- seventeen, and a missed incentive would be indistinguishable from a
-- deliberate zero. So confirmation is its own act, with its own row, its own
-- actor and its own timestamp.
--
-- ZERO IS NOT A CONFIRMATION EITHER. `Incentive = 0` is the same statement as
-- an empty cell: no incentive. It does not create a component row (see the
-- import), and it does not set the flag below.
--
-- THE FLAG IS CLEARED THE MOMENT AN ADJUSTMENT APPEARS. A confirmed-none
-- employee who is later given an Incentive is no longer a confirmed-none
-- employee; the repository revokes it in the SAME transaction as the write, so
-- the two facts cannot disagree, and the revocation is audited below.
--
-- `remarks` LIVES HERE RATHER THAN ON EACH COMPONENT because the sheet has one
-- Remarks column per EMPLOYEE, not one per amount, and storing it six times
-- would be six copies to keep in step.
CREATE TABLE IF NOT EXISTS `payrun_employee_adjustment_state` (
  `payrun_adjustment_state_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,

  `remarks` VARCHAR(500) NULL DEFAULT NULL,

  -- THE EXPLICIT CONFIRMATION. 0 is not "denied"; it is "nobody has said".
  `confirmed_no_adjustment` TINYINT(1) NOT NULL DEFAULT 0,
  -- WHO AND WHEN, and they are NULL together with the flag. A confirmation
  -- with nobody's name on it is not one - that is the entire audit that was
  -- asked for, and it is why the pair is stored rather than derived from the
  -- log table below.
  `confirmed_by` INT NULL DEFAULT NULL,
  `confirmed_at` TIMESTAMP NULL DEFAULT NULL,

  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_adjustment_state_id`),
  UNIQUE KEY `uq_payrun_adjustment_state_month`
    (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_adjustment_state_month` (`period_year`, `period_month`),
  CONSTRAINT `fk_payrun_adjustment_state_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================================= 3. The change log
--
-- APPEND ONLY, ONE ROW PER MATERIAL CHANGE, and it records BOTH amounts rather
-- than only the new one: "Incentive set to 2,000" does not say whether that
-- was a correction of 2,500 or the first entry, and a month that has been
-- edited twice is unreadable without the pair.
--
-- IT RECORDS WHERE THE CHANGE CAME FROM. `source` is IMPORT or MANUAL, because
-- the first question asked about a wrong figure in a payroll month is whether
-- somebody typed it or a spreadsheet carried it, and answering that from the
-- timestamps of two hundred rows is guesswork.
--
-- THE CONFIRMATION AND ITS REVOCATION ARE LOGGED HERE TOO, with a NULL
-- component and NULL amounts. They are changes to what the month asserts about
-- an employee, which is exactly what this table is for; a separate table for
-- them would mean reading two logs to reconstruct one employee's month.
CREATE TABLE IF NOT EXISTS `payrun_employee_adjustment_audit` (
  `payrun_adjustment_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL,
  `employee_id`  INT NOT NULL,

  `action` ENUM(
    'SET_AMOUNT','CLEAR_AMOUNT',
    'SET_REMARKS',
    'CONFIRM_NO_ADJUSTMENT','REVOKE_NO_ADJUSTMENT'
  ) NOT NULL,

  `component` ENUM(
    'INCENTIVE','BONUS','ARREARS',
    'ADVANCE_RECOVERY','SHORTAGE_RECOVERY',
    'BALANCE_ADVANCE'
  ) NULL DEFAULT NULL,

  `old_amount` DECIMAL(12,2) NULL DEFAULT NULL,
  `new_amount` DECIMAL(12,2) NULL DEFAULT NULL,

  `source` ENUM('MANUAL','IMPORT') NOT NULL DEFAULT 'MANUAL',
  `source_filename` VARCHAR(255) NULL DEFAULT NULL,

  `changed_by` INT NULL DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_adjustment_audit_id`),
  KEY `idx_payrun_adjustment_audit_employee_month`
    (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_adjustment_audit_payrun` (`payrun_employee_id`),
  CONSTRAINT `fk_payrun_adjustment_audit_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ======================================= 4. NO NEW PERMISSION KEY IS ADDED
--
-- AND THAT IS A DECISION, NOT AN OMISSION. Three keys already answer every
-- question this stage asks:
--
--   view_employees   what every /hr and /payrun read already demands
--   view_payroll     opening the Payrun screen and reading a month
--   view_salary      the Adjustments screen shows per-employee amounts of
--                    money, which is the same disclosure the initialization
--                    screen's Approved Monthly Gross is governed by
--   process_payroll  ENTERING, EDITING, CLEARING AND CONFIRMING adjustments.
--                    M2 declared this key as "run a payroll period" and the
--                    initialization stage claimed it for Initialize; putting
--                    figures into that same month is the same person doing the
--                    same job, on the same month, one stage later.
--
-- WHY NOT AN `adjust_payrun` KEY. It would have to be granted to everybody who
-- already holds `process_payroll` on the day it shipped, or the people who run
-- payroll would lose the ability to finish a month - at which point it says
-- nothing. And if it were NOT granted to them, it would be a second, quieter
-- answer to "who may put money into a payroll month", which is the kind of
-- right that ends up granted by accident. `change_payrun_pay_type` is separate
-- because it is a genuinely different decision - HOW the money travels, the
-- payment desk's act. An adjustment is HOW MUCH, which is the payroll
-- processor's act and already has a key.
