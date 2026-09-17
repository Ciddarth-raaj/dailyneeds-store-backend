-- Payrun Initialization - the monthly payroll snapshot, and the month itself.
--
-- ADDITIVE ONLY. Three new tables, one new permission declaration. No existing
-- table is altered, no existing row is written, and NOTHING here reads or
-- changes `new_employee.payment_type`, `employee_salary` or any attendance
-- table: this migration creates the place a payroll month is recorded and
-- nothing that records one.
--
-- Every statement is guarded so the whole file can be re-run without error,
-- exactly as the M2 and attendance-v2 migrations are.

-- ============================================== 1. The payroll month itself
--
-- WHY A TABLE FOR A MONTH. Until now a payroll month was not a thing the
-- database knew about - `services/salary_period_lock.js` says so in as many
-- words, and answers "unlocked, because monthly payroll is not implemented".
-- Initialization is the first act that treats a month as an object with a
-- state, so the month needs somewhere to have one.
--
-- NO ROW MEANS OPEN, AND THAT IS DELIBERATE. Backfilling a row for every month
-- since the business started would be inventing history; a month nobody has
-- ever acted on is simply open, and the row appears when somebody locks it.
-- Readers must therefore treat a missing row as OPEN and never as an error.
--
-- NOTHING LOCKS A MONTH YET. Finalize / lock is explicitly out of scope for
-- this stage, so this table gains rows only when that stage is built. It
-- exists now because the eligibility rule "the month is not locked" has to be
-- answerable from the database rather than from a promise, and because a
-- payrun row's foreign key needs a month to point at conceptually even though
-- it is not enforced as one (a payrun may be taken for a month with no row).
CREATE TABLE IF NOT EXISTS `payrun_period` (
  `payrun_period_id` INT NOT NULL AUTO_INCREMENT,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',

  `status` ENUM('OPEN','LOCKED') NOT NULL DEFAULT 'OPEN',

  -- Who locked it and when. NULL while the month is open, and the pair is the
  -- whole audit: a month that closed itself with nobody named would not be one.
  `locked_at` TIMESTAMP NULL DEFAULT NULL,
  `locked_by` INT NULL DEFAULT NULL,

  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_period_id`),
  UNIQUE KEY `uq_payrun_period` (`period_year`, `period_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================= 2. The per-employee monthly snapshot
--
-- WHAT INITIALIZATION ACTUALLY IS. Before it, an employee's month is a live
-- view: their approved salary, their calculated attendance, their statutory
-- flags, all of them free to move. After it, this row exists, and the month is
-- computed from THIS ROW rather than from the sources it was taken from.
--
-- SO THE SNAPSHOT IS THE WHOLE POINT, AND IT IS WHY THE VALUES ARE COPIED
-- rather than joined to at read time. A join is not a snapshot: an approved
-- revision back-dated into a month that has already been initialized would
-- silently change what a joined query returned, which is exactly the silent
-- mutation this stage exists to stop. A later, explicit Recalculate is what
-- refreshes these values, and it is not built here.
--
-- WHAT IS REFERENCED RATHER THAN COPIED, and the rule that decides which:
-- where the source is already IMMUTABLE AND VERSIONED, the row keeps the
-- reference. `employee_salary` rows are never edited once approved (M2's
-- immutability rule) and `attendance_monthly_payroll` carries its own
-- `payroll_version` and `calculated_at`, so `salary_id` and
-- `attendance_monthly_payroll_id` are safe references and duplicating the
-- whole of either table here would be storing the same fact twice. The salary
-- AMOUNTS are copied anyway, because payroll reads them on every screen and a
-- payslip must be explainable from one row.
--
-- ONE ROW PER EMPLOYEE PER MONTH, ENFORCED BY THE DATABASE. The unique key
-- below is what makes initialization idempotent: a repeated Initialize, two
-- browser tabs, or a bulk run overlapping a single one cannot produce a second
-- snapshot, whatever the application layer believes. An application-only check
-- is a race with a comment on it.
CREATE TABLE IF NOT EXISTS `payrun_employee` (
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `employee_id`  INT NOT NULL,

  -- ------------------------------------------------- who they were, that month
  -- Names and not just ids, because a payroll month has to still explain itself
  -- after somebody transfers branch, changes designation or leaves. The ids are
  -- kept beside them for joining; the text is what a stored month asserts.
  `employee_name`    VARCHAR(255) NULL DEFAULT NULL,
  `store_id`         INT NULL DEFAULT NULL,
  `store_name`       VARCHAR(255) NULL DEFAULT NULL,
  `designation_id`   INT NULL DEFAULT NULL,
  `designation_name` VARCHAR(255) NULL DEFAULT NULL,
  `department_id`    INT NULL DEFAULT NULL,

  -- The employment window the month was priced inside. `date_of_joining` is a
  -- legacy VARCHAR in `new_employee`; it is parsed by the ONE shared parser
  -- (`utils/joining_date.js`) on the way in and stored here as a real DATE, so
  -- no reader of a payrun ever parses that column again.
  `date_of_joining`  DATE NULL DEFAULT NULL,
  `resignation_date` DATE NULL DEFAULT NULL,

  -- ------------------------------------------------------- the approved salary
  -- WHICH revision, WHEN it took effect, and the structure it produced. The id
  -- is the immutable reference; the amounts are what payroll reads downstream.
  `salary_id`             INT NULL DEFAULT NULL,
  `salary_effective_from` DATE NULL DEFAULT NULL,
  `monthly_gross`     DECIMAL(12,2) NULL DEFAULT NULL,
  `daily_salary`      DECIMAL(12,2) NULL DEFAULT NULL,
  `basic`             DECIMAL(12,2) NULL DEFAULT NULL,
  `conveyance`        DECIMAL(12,2) NULL DEFAULT NULL,
  `hra`               DECIMAL(12,2) NULL DEFAULT NULL,
  `special_allowance` DECIMAL(12,2) NULL DEFAULT NULL,

  -- ------------------------------------------------------ statutory applicability
  -- The FLAGS AND IDENTIFIERS downstream PF/ESI work needs, frozen as they were
  -- when the month was initialized. No contribution is stored: what is
  -- contributed is `utils/salary_engine.js`'s answer and is a later stage's to
  -- compute, exactly as `attendance_monthly_payroll` refuses to assert a
  -- statutory base.
  `pf_applicable`  TINYINT(1) NULL DEFAULT NULL,
  `esi_applicable` TINYINT(1) NULL DEFAULT NULL,
  `uan`            VARCHAR(45) NULL DEFAULT NULL,
  `pf_number`      VARCHAR(45) NULL DEFAULT NULL,
  `esi_number`     VARCHAR(45) NULL DEFAULT NULL,

  -- --------------------------------------------- the attendance the month used
  -- A REFERENCE AND ITS VERSION MARKERS, never a copy of the numbers. The
  -- attendance engine owns those and recomputing or duplicating them here is
  -- how payroll and attendance start disagreeing about a month. `payroll_version`
  -- and `calculated_at` are copied because they are what tells a later
  -- Recalculate whether the stored attendance has moved since.
  `attendance_monthly_payroll_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `attendance_payroll_version`    INT NULL DEFAULT NULL,
  `attendance_calculated_at`      TIMESTAMP(3) NULL DEFAULT NULL,

  -- ------------------------------------------------------- the monthly pay type
  -- BANK OR CASH, FOR THIS MONTH ONLY. Defaulted from the Employee Master
  -- (`payment_type` 1/2), or CASH for somebody who has left, and changeable
  -- afterwards for this month alone. Changing it NEVER writes back to
  -- `new_employee` - there is no UPDATE of that column anywhere in this
  -- feature, and a test asserts it.
  --
  -- THERE IS NO 'HOLD' VALUE. Holding pay is a payroll STATUS, not a route the
  -- money travels by; a held employee still has to have a recorded pay type for
  -- the day the hold lifts.
  `pay_type` ENUM('BANK','CASH') NOT NULL,
  `pay_type_source` ENUM('EMPLOYEE_MASTER','RESIGNED_DEFAULT','MANUAL') NOT NULL
    COMMENT 'where the CURRENT value came from - inherited, the resigned default, or somebody chose it',

  -- ------------------------------------------------------------------ the row
  -- One value today. The column exists because the stages after this one -
  -- calculated, approved, finalized, paid - are states of THIS row, and adding
  -- the column later would mean backfilling every snapshot ever taken.
  `status` ENUM('INITIALIZED') NOT NULL DEFAULT 'INITIALIZED',

  `initialized_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `initialized_by` INT NULL DEFAULT NULL,
  `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_employee_id`),
  -- IDEMPOTENCY, IN THE DATABASE. See the note above.
  UNIQUE KEY `uq_payrun_employee_month` (`period_year`, `period_month`, `employee_id`),
  KEY `idx_payrun_employee_month` (`period_year`, `period_month`),
  KEY `idx_payrun_employee_employee` (`employee_id`),
  CONSTRAINT `fk_payrun_employee_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ======================================== 3. The pay type change audit
--
-- APPEND ONLY, ONE ROW PER CHANGE, and it records the two values rather than
-- just the new one: "changed to Cash" does not say what it was, and a month
-- that has been flipped twice is unreadable without the pair.
--
-- NO REASON COLUMN, DELIBERATELY. Moving somebody between bank and cash for
-- one month is an ordinary operational act - a closed account, a person who
-- will not be at the branch - and demanding a justification for it would
-- produce six hundred rows reading "cash". WHO and WHEN is the audit that was
-- asked for; a reason column nobody fills honestly is worse than none.
CREATE TABLE IF NOT EXISTS `payrun_employee_pay_type_audit` (
  `payrun_pay_type_audit_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL,
  `employee_id`  INT NOT NULL,

  `old_pay_type` ENUM('BANK','CASH') NOT NULL,
  `new_pay_type` ENUM('BANK','CASH') NOT NULL,

  `changed_by` INT NULL DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`payrun_pay_type_audit_id`),
  KEY `idx_payrun_pay_type_audit_row` (`payrun_employee_id`),
  KEY `idx_payrun_pay_type_audit_month` (`period_year`, `period_month`, `employee_id`),
  CONSTRAINT `fk_payrun_pay_type_audit_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ==================================== 4. The one new permission key
--
-- DECLARED HERE, GRANTED TO NOBODY, exactly as M2 declared the salary keys.
-- Administrators reach it through the `user_type = 2` bypass in
-- `middlewares/permissions.js`; everybody else is granted it deliberately, one
-- designation at a time, on the Designation screen.
--
-- ONLY ONE KEY IS ADDED, AND THE OTHER TWO DECISIONS REUSE THE KEYS M2 ALREADY
-- DECLARED FOR EXACTLY THIS:
--
--   view_payroll      opening the Payrun screen and reading a month
--   process_payroll   INITIALIZING - M2 declared it as "run a payroll period
--                     (not built in M2)", and this is that act. Inventing an
--                     `initialize_payrun` key beside it would leave
--                     `process_payroll` gating nothing forever and give
--                     administrators two boxes to tick for one decision.
--
--   change_payrun_pay_type   THE NEW ONE, and it is genuinely a different
--                     decision. Initializing a month freezes what somebody is
--                     owed; moving them between bank and cash decides HOW the
--                     money reaches them, which is the payment desk's act and
--                     not the payroll processor's. Somebody may reasonably hold
--                     either without the other, and one key covering both would
--                     mean the person who runs the month can also redirect
--                     where every payment goes.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
    SELECT 'change_payrun_pay_type' AS `permission_key`
  ) k
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key` );
