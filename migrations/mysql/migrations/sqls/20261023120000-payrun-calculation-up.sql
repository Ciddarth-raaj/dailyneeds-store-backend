-- Payrun Calculation & Review - the calculated month, and the approval that
-- locks one employee's part of it.
--
-- ADDITIVE ONLY. Two new tables and one new permission declaration. No
-- existing table is altered, no existing row is written, and nothing here
-- reads or changes `payrun_employee`, `payrun_employee_adjustment`,
-- `employee_salary`, `new_employee` or any attendance table: this migration
-- creates the place a calculation and its approval are recorded and nothing
-- that records one.
--
-- IN PARTICULAR, `payrun_employee.status` IS NOT ALTERED. It is
-- ENUM('INITIALIZED') and it stays that way. Adding CALCULATED and
-- APPROVED_LOCKED to it was the obvious move and is the wrong one: the
-- calculation is a row with thirty figures, a version, two source
-- fingerprints and an approval audit on it, and a status on the snapshot would
-- be a thirty-first copy of the answer that can disagree with the other
-- thirty. The snapshot says the month was initialized - which is still true
-- after it is calculated - and this table says everything that happened next.
--
-- Every statement is guarded so the whole file can be re-run without error,
-- exactly as the initialization and adjustments migrations are.

-- ===================================== 1. The per-employee calculated month
--
-- ONE ROW PER EMPLOYEE PER MONTH, AND NOT VERSION ROWS. The specification
-- allows either and asks that the choice be deliberate, so:
--
--   a recalculation OVERWRITES this row and bumps `calculation_revision`. What
--   a payroll month has to be able to answer is "what is this employee's
--   current calculation, and can I approve it" - and with version rows, every
--   one of those questions becomes "...where is_current = 1", which is a
--   predicate somebody eventually forgets in a query that decides pay.
--
--   the HISTORY THAT MATTERS IS KEPT ANYWAY, in
--   `payrun_employee_calculation_audit` below: every calculate, recalculate
--   and approval is an append-only row carrying the net pay and the
--   calculation hash at that moment. So "what did it say before somebody
--   recalculated it" is answerable, without the current answer needing a
--   predicate to find.
--
--   AND THE ROW THAT MUST NEVER MOVE CANNOT. Once `status` is APPROVED_LOCKED
--   the application refuses every write to it (see
--   `usecase/payrun_calculation.js`), so the version-row argument - "an
--   approved calculation must be immutable" - is satisfied by the lock rather
--   than by keeping every draft forever.
--
-- WHY THE FIGURES ARE STORED AT ALL RATHER THAN RECOMPUTED ON READ. Because
-- the whole stage exists to stop a month moving under somebody: a screen that
-- recomputed from the sources would show a different net pay the moment a
-- salary was approved, which is precisely the silent mutation initialization
-- was built to prevent. The stored figures are what was calculated; the two
-- hashes below are how the row notices that the world has moved without
-- moving with it.
--
-- EVERY VALUE NEEDED TO REPRODUCE **AND EXPLAIN** THE PAYROLL IS HERE. Not
-- just net pay: the day counts, the rates, the OT hours and the NRM they were
-- priced on, each adjustment component, both statutory wages and both sides of
-- each contribution. A payslip that can only be explained by re-running an
-- engine is a payslip nobody can defend to the person it belongs to.
CREATE TABLE IF NOT EXISTS `payrun_employee_calculation` (
  `payrun_calculation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,

  -- ------------------------------------------------- what went in: the sources
  -- THE IDENTITY OF EVERY SOURCE THIS CALCULATION CONSUMED, so that "has
  -- anything moved since" is answerable without re-running anything. Ids and
  -- versions where the source has them - an APPROVED `employee_salary` row is
  -- immutable and `attendance_monthly_payroll` carries its own
  -- `payroll_version` and `calculated_at` - and the amounts beside them,
  -- because a marker set a human cannot read is a marker set nobody can debug.
  `salary_id`             INT NULL DEFAULT NULL,
  `salary_effective_from` DATE NULL DEFAULT NULL,
  `monthly_gross`         DECIMAL(12,2) NULL DEFAULT NULL,

  `attendance_monthly_payroll_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `attendance_payroll_version`    INT NULL DEFAULT NULL,
  `attendance_calculated_at`      TIMESTAMP(3) NULL DEFAULT NULL,

  -- THE EFFECTIVE NRM AND WHERE IT CAME FROM, and the pair is stored together
  -- because the number alone is a support call. Two employees on the same
  -- shift may have different OT rates ONLY when one of them has a lunch/break
  -- override, and this column is what says which case a row is. The payrun
  -- never reads the shift master to answer it: attendance already resolved the
  -- employee-specific value and this stage consumes that answer.
  `effective_nrm_minutes` INT NULL DEFAULT NULL,
  `effective_nrm_source`  ENUM('SHIFT','EMPLOYEE_OVERRIDE') NULL DEFAULT NULL,

  -- THE STATUTORY APPLICABILITY THIS CALCULATION CHARGED ON. Frozen here as
  -- well as on the snapshot, because it is a SOURCE MARKER: an employee moved
  -- into or out of PF or ESI after the month was calculated changes what they
  -- are owed, and the stale-detection below compares what the calculation used
  -- against what is true now. Comparing against a column that was not stored
  -- would make every calculated employee read as stale forever.
  `pf_applicable`  TINYINT(1) NULL DEFAULT NULL,
  `esi_applicable` TINYINT(1) NULL DEFAULT NULL,

  -- TWO FINGERPRINTS, NOT ONE, and the separation is deliberate. `source_hash`
  -- covers what is OUTSIDE the payrun - salary, attendance, approved OT,
  -- effective NRM, statutory applicability - so a change to any of them is a
  -- SOURCE moving under a frozen month. `inputs_hash` covers what the payrun
  -- itself owns - the six adjustment components and the monthly pay type - so
  -- a change there is somebody deliberately editing this month. Both make the
  -- stored net pay stale and both stop an approval; they are reported with
  -- different reasons because they are different events with different people
  -- to go and talk to.
  `source_hash` CHAR(32) NOT NULL,
  `inputs_hash` CHAR(32) NOT NULL,

  -- ------------------------------------------------------------- the salary
  -- CONSUMED FROM THE ATTENDANCE RESULT, NEVER RE-DERIVED. There is no punch,
  -- shift or minute anywhere in this feature: Salary Days, Extra Days, the
  -- shortage minutes and the deduction are the attendance engine's answers,
  -- copied here so the month can be explained from one row.
  `daily_rate`              DECIMAL(12,2) NULL DEFAULT NULL COMMENT 'Monthly Gross / 26',
  `salary_days`             INT NOT NULL DEFAULT 0,
  `salary_earnings`         DECIMAL(12,2) NULL DEFAULT NULL,
  `missing_hours_minutes`   INT NOT NULL DEFAULT 0,
  `missing_hours_deduction` DECIMAL(12,2) NULL DEFAULT NULL,
  `extra_days`              INT NOT NULL DEFAULT 0,
  `extra_day_amount`        DECIMAL(12,2) NULL DEFAULT NULL
    COMMENT 'paid separately. Excluded from PF and from ESI by construction',

  -- ----------------------------------------------------------------- the OT
  -- ONLY APPROVED OT IS HERE. `approved_ot_minutes` is the one overtime figure
  -- the attendance engine says payroll may read; candidate and raw minutes are
  -- worth nothing until somebody approves them and are not stored.
  --
  -- `attendance_ot_earnings` IS CARRIED FOR RECONCILIATION AND USED FOR
  -- NOTHING. Attendance prices OT per DATE, on that date's NRM and that
  -- weekday's multiplier; the payrun prices it once, on the month's effective
  -- NRM, with no multiplier, because that is the agreed Daily Needs contract.
  -- The two may differ and the difference is visible rather than silent.
  `approved_ot_minutes`    INT NOT NULL DEFAULT 0,
  `approved_ot_hours`      DECIMAL(10,4) NOT NULL DEFAULT 0,
  `ot_hourly_rate`         DECIMAL(12,2) NULL DEFAULT NULL
    COMMENT 'Daily Rate / Effective NRM hours. NULL when the month has more than one OT NRM - see ot_groups',
  `ot_amount`              DECIMAL(12,2) NULL DEFAULT NULL,
  -- HOW THE OVERTIME WAS ACTUALLY PRICED: one entry per NRM that carried
  -- approved OT, each with its own minutes, source and rate.
  --
  -- WHY A BREAKDOWN AND NOT ONE RATE. The hourly rate is Daily Rate / NRM, so
  -- an hour worked against an 8-hour NRM and an hour worked against an 11-hour
  -- one are worth different amounts. An employee with approved OT on both has
  -- no single correct rate, and applying either to all of it misprices
  -- whichever hours belong to the other. The groups come from
  -- `attendance_day_calculation`, which has already resolved the
  -- employee-specific NRM per date; the payrun consumes that split and never
  -- re-derives it.
  --
  -- JSON, because the shape is a small list owned entirely by this row and
  -- read only with it. A child table would be a join on every payslip to
  -- reconstruct a figure this row already states.
  `ot_groups`              JSON NULL COMMENT 'per-NRM OT breakdown that produced ot_amount',

  -- -------------------------------------------------------- the adjustments
  -- ONE COLUMN PER COMPONENT rather than a join at read time, for the same
  -- reason the salary amounts are copied: an approved month must still explain
  -- itself after somebody edits next month's adjustments, and a join is not a
  -- snapshot. The live rows stay in `payrun_employee_adjustment`; these are
  -- what THIS calculation consumed.
  `incentive`         DECIMAL(12,2) NOT NULL DEFAULT 0,
  `bonus`             DECIMAL(12,2) NOT NULL DEFAULT 0,
  `arrears`           DECIMAL(12,2) NOT NULL DEFAULT 0,
  `advance_recovery`  DECIMAL(12,2) NOT NULL DEFAULT 0,
  `shortage_recovery` DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- INFORMATIONAL. Zero effect on every other column in this table. It is
  -- stored so a payslip can print the remaining advance balance, and a test
  -- asserts that changing it changes nothing else.
  `balance_advance`   DECIMAL(12,2) NOT NULL DEFAULT 0,

  -- ------------------------------------------------------------- statutory
  -- COMPUTED BY `utils/salary_engine.js` AND BY NOTHING ELSE. No rate, no
  -- ceiling and no EPS rule is implemented in the payrun; what is stored here
  -- is that engine's answer on this month's earned bases.
  --
  --   PF wage  = earned Basic for SALARY DAYS only. Extra Days, OT, Incentive,
  --              Bonus and Arrears are excluded; the recoveries and the
  --              Balance Advance have no PF effect at all.
  --   ESI wage = eligible normal salary earnings only, through the Code on
  --              Social Security wage definition. Same exclusions.
  `pf_status`         VARCHAR(32) NULL DEFAULT NULL,
  `pf_wage`           DECIMAL(12,2) NULL DEFAULT NULL,
  `employee_pf`       DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_pf_total` DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_epf`      DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_eps`      DECIMAL(12,2) NULL DEFAULT NULL,

  `esi_status`     VARCHAR(32) NULL DEFAULT NULL,
  `esi_wage`       DECIMAL(12,2) NULL DEFAULT NULL,
  `esi_wage_basis` VARCHAR(32) NULL DEFAULT NULL,
  `employee_esi`   DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_esi`   DECIMAL(12,2) NULL DEFAULT NULL,

  -- HOW THE CONTRIBUTION-PERIOD QUESTION WAS ANSWERED, stored beside the
  -- contribution it decided.
  --
  -- ESI DOES NOT STOP WHEN WAGES CROSS THE CEILING. Coverage is decided once
  -- per contribution period - at its start, or at the employee's entry into it
  -- if they joined part-way through - and somebody covered at that moment stays
  -- covered to the end of the period whatever their wages do in between. A
  -- contribution that differs from what the ceiling alone would give has to be
  -- able to say why, months later, without anybody re-deriving it.
  --
  -- THE ENTRY RECORD IS NAMED because it is a SOURCE: a revision back-dated
  -- into the month the period began changes whether this month is covered,
  -- while `salary_id` above stays exactly as it was. It is part of the source
  -- hash for that reason.
  --
  -- `esi_contribution_period_continues` IS NULLABLE AND THE NULL MEANS
  -- SOMETHING: the server could not establish the position at entry. Above the
  -- ceiling that is an open question and the contribution is stored as
  -- unresolved rather than as a zero - see the `unresolved` column.
  `esi_period_start`            DATE NULL DEFAULT NULL,
  `esi_period_end`              DATE NULL DEFAULT NULL,
  `esi_coverage_entry_date`     DATE NULL DEFAULT NULL,
  `esi_coverage_entry_salary_id` INT NULL DEFAULT NULL,
  `esi_coverage_entry_gross`    DECIMAL(12,2) NULL DEFAULT NULL
    COMMENT 'the gross of that record. Stored because it is a source marker, not for arithmetic',
  `esi_coverage_basis`          VARCHAR(48) NULL DEFAULT NULL,
  `esi_contribution_period_continues` TINYINT(1) NULL DEFAULT NULL
    COMMENT '1 covered at entry, 0 not, NULL could not be established',

  -- ----------------------------------------------------------------- final
  `total_earnings`            DECIMAL(12,2) NULL DEFAULT NULL,
  `total_employee_deductions` DECIMAL(12,2) NULL DEFAULT NULL,
  `net_pay`                   DECIMAL(12,2) NULL DEFAULT NULL,
  -- THE PAY TYPE **AS CALCULATED**, so a locked record says how the money was
  -- to travel. The live monthly value stays on `payrun_employee`; a change to
  -- it after calculation moves `inputs_hash` and requires a recalculation.
  `pay_type` ENUM('BANK','CASH') NOT NULL,

  -- THE QUESTIONS THE ENGINE REFUSED TO ANSWER WITH A NUMBER, as the engine's
  -- own codes. An employee with any of them cannot be approved: a zero that
  -- should have been a contribution is a filing error nobody notices for a
  -- year, and approving one is how it gets filed.
  `unresolved` JSON NULL,
  `errors`     JSON NULL,
  `is_complete` TINYINT(1) NOT NULL DEFAULT 0,

  -- ------------------------------------------------- the calculation itself
  -- THREE DIFFERENT THINGS, AND THEY ARE NOT INTERCHANGEABLE:
  --   calculation_version   which ENGINE produced this. Bumped when a formula
  --                         changes. Deliberately NOT part of `source_hash`:
  --                         a formula change is not a source change, and
  --                         conflating them would mark every employee in every
  --                         open month as stale the moment the number moves.
  --   calculation_revision  how many times THIS employee's month has been
  --                         calculated. 1 on the first, +1 on each recalculate.
  --   calculation_hash      a fingerprint of the ANSWER - the figures - which
  --                         is what an approval is recorded against. A hash of
  --                         the inputs would not do: two engine versions can
  --                         consume identical inputs and produce different net
  --                         pay, and what somebody approved is the net pay.
  `calculation_version`  INT NOT NULL,
  `calculation_revision` INT NOT NULL DEFAULT 1,
  `calculation_hash`     CHAR(32) NOT NULL,
  `calculated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `calculated_by` INT NULL DEFAULT NULL,

  -- ------------------------------------------------- the approval and lock
  -- TWO STORED VALUES AND NO MORE. `CALCULATED` means a calculation exists;
  -- `APPROVED_LOCKED` means somebody approved it. The other three states the
  -- screen shows - not calculated, recalculation required, ready for approval
  -- - are answers to "how does this row compare with the world RIGHT NOW", and
  -- the world moves without anybody touching the row. Storing them would mean
  -- a nightly sweep that is wrong in between; they are computed when asked
  -- for, by `utils/payrun_calculation.js#deriveStatus`.
  `status` ENUM('CALCULATED','APPROVED_LOCKED') NOT NULL DEFAULT 'CALCULATED',

  -- APPROVAL AND LOCK ARE RECORDED AS **TWO PAIRS**, and that is not
  -- redundancy. Today they are written in the same transaction and hold the
  -- same values, because approval IS the lock. The future correction path -
  -- Unpublish, Delete Payslip, UNLOCK, Recalculate, Review, Approve & Lock
  -- again - separates them: after an unlock, the row is no longer locked while
  -- the fact that it was once approved, by whom and when, is exactly what an
  -- auditor will ask for. One pair of columns would have to be overwritten to
  -- express that, and the answer would be gone.
  `approved_by` INT NULL DEFAULT NULL,
  `approved_at` TIMESTAMP NULL DEFAULT NULL,
  `locked_by`   INT NULL DEFAULT NULL,
  `locked_at`   TIMESTAMP NULL DEFAULT NULL,

  -- RESERVED FOR THE FUTURE UNLOCK, AND WRITTEN BY NOTHING TODAY. No code path
  -- in this stage sets any of the three - unlock is explicitly out of scope -
  -- and they exist now because the specification requires the schema not to
  -- prevent that path. Adding them later would mean an ALTER on a table
  -- holding approved payroll, which is the migration nobody wants to run.
  --
  -- THE UNLOCK THEY DESCRIBE IS PER EMPLOYEE AND PER MONTH, which the primary
  -- key of this table already guarantees: there is no month-wide lock anywhere
  -- in this feature, and `payrun_period.status` is untouched by it.
  `unlocked_by`     INT NULL DEFAULT NULL,
  `unlocked_at`     TIMESTAMP NULL DEFAULT NULL,
  `unlock_reason`   VARCHAR(500) NULL DEFAULT NULL,

  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_calculation_id`),
  -- ONE CALCULATION PER EMPLOYEE PER MONTH, ENFORCED BY THE DATABASE. The same
  -- guarantee the snapshot has, for the same reason: two browser tabs, or a
  -- bulk run overlapping a single one, cannot produce a second calculation
  -- whatever the application layer believes. An application-only check is a
  -- race with a comment on it.
  UNIQUE KEY `uq_payrun_calculation_month` (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_calculation_month` (`period_year`, `period_month`),
  KEY `idx_payrun_calculation_status` (`period_year`, `period_month`, `status`),
  KEY `idx_payrun_calculation_payrun` (`payrun_employee_id`),
  CONSTRAINT `fk_payrun_calculation_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================== 2. The calculation audit log
--
-- APPEND ONLY, ONE ROW PER ACT, and it carries the net pay and the calculation
-- hash AT THAT MOMENT. That is what makes overwriting the row above safe: "what
-- did this employee's month say before somebody recalculated it, and who
-- recalculated it" is answerable from here, so the current answer does not need
-- a version predicate to be found.
--
-- `UNLOCK` IS IN THE ENUM AND IS WRITTEN BY NOTHING. Same reason as the unlock
-- columns above: the future controlled correction path must not require an
-- ALTER on a table holding payroll audit.
CREATE TABLE IF NOT EXISTS `payrun_employee_calculation_audit` (
  `payrun_calculation_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL,
  `employee_id`  INT NOT NULL,

  `action` ENUM('CALCULATE','RECALCULATE','APPROVE_LOCK','UNLOCK') NOT NULL,

  `calculation_version`  INT NULL DEFAULT NULL,
  `calculation_revision` INT NULL DEFAULT NULL,
  `calculation_hash`     CHAR(32) NULL DEFAULT NULL,
  `source_hash`          CHAR(32) NULL DEFAULT NULL,
  `net_pay`              DECIMAL(12,2) NULL DEFAULT NULL,

  `changed_by` INT NULL DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_calculation_audit_id`),
  KEY `idx_payrun_calculation_audit_employee_month`
    (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_calculation_audit_payrun` (`payrun_employee_id`),
  CONSTRAINT `fk_payrun_calculation_audit_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ==================================== 3. The one new permission key
--
-- DECLARED HERE, GRANTED TO NOBODY, exactly as M2 declared the salary keys and
-- as the initialization stage declared `change_payrun_pay_type`.
-- Administrators reach it through the `user_type = 2` bypass in
-- `middlewares/permissions.js`; everybody else is granted it deliberately, one
-- designation at a time, on the Designation screen.
--
-- ONLY ONE KEY IS ADDED, AND EVERYTHING ELSE IN THIS STAGE REUSES THE EXISTING
-- ONES:
--
--   view_employees / view_payroll / view_salary   reading a calculated month,
--                     which shows per-employee net pay across the company -
--                     the same disclosure the initialization and adjustments
--                     stages are governed by
--   process_payroll   CALCULATING and RECALCULATING. M2 declared this key as
--                     "run a payroll period", initialization claimed it for
--                     Initialize and adjustments for entering figures;
--                     computing the month from them is the same person doing
--                     the same job one stage later.
--
--   approve_payrun    THE NEW ONE, and it is genuinely a different decision.
--                     This repository already separates "propose" from
--                     "approve" where money is concerned - `add_salary` and
--                     `approve_salary_revision` are deliberately two keys, for
--                     exactly this reason - and approval here is stronger than
--                     a salary approval: it LOCKS the employee's month, after
--                     which the figures cannot be recalculated, the
--                     adjustments cannot be edited and the pay type cannot be
--                     changed. Letting `process_payroll` do it would mean the
--                     person who enters an incentive also signs it off, which
--                     is the separation of duties payroll exists to keep.
--
-- IT IS NOT A SECOND WAY TO DO SOMETHING THAT ALREADY HAS A KEY, which is the
-- test the adjustments migration applied when it declined to add one: nothing
-- today can approve or lock a payroll month, so this key gates an act rather
-- than duplicating one.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
    SELECT 'approve_payrun' AS `permission_key`
  ) k
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key` );
