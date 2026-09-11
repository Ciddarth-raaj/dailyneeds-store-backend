-- M2 — the Salary Engine and the salary schema.
--
-- ADDITIVE ONLY. Two new columns on `new_employee`, one new table, and eight
-- permission declarations. No employee row is written, no existing value
-- changes meaning, and `new_employee.salary` is neither read, copied nor
-- dropped by this migration.
--
-- Every statement is guarded so the whole file can be re-run without error -
-- MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration that cannot be
-- re-run is one that cannot be recovered halfway through, which is exactly
-- when it matters.

-- ==================================== 1. Existing / Previous PF Member
--
-- A THIRD, SEPARATE STATUTORY FACT. It is not PF Applicable (is this employee
-- in the scheme now), it is not the UAN and it is not the PF Number (what are
-- their identifiers). It is: had this person already been a provident fund
-- member before they joined?
--
-- WHY PAYROLL NEEDS IT. It is the EPF half of the Form 11 declaration and the
-- fact an EPF transfer claim is raised from. It is NOT the fact the pension
-- split is decided by - that is `previous_eps_member` in section 2 below, and
-- the engine reads that one and only that one.
--
-- WHY IT IS NOT `pf`. The legacy `pf VARCHAR(45)` column is free text of
-- unknown provenance that the target architecture already marks for
-- replacement. Overloading it to mean "previous member" would give one column
-- two meanings and no way to tell which one a given row carries. It is left
-- exactly as it is.
--
-- TRI-STATE, AND WHY NULL IS A REAL VALUE. Exactly as `pf_applicable` and
-- `esi_applicable`: 1 yes, 0 no, NULL nobody has said yet. There is no
-- backfill and no default, because defaulting six hundred real people to
-- either answer would be a migration asserting a statutory fact about their
-- employment history that it did not witness.
--
-- SAFE FOR THE NIGHTLY SYNC. `services/synker.js` builds its
-- `INSERT ... ON DUPLICATE KEY UPDATE` from the keys present in the Digisme
-- payload, and this is not one of them, so the 07:00 sync can neither set nor
-- clear it - the same protection `pf_applicable` and the bank columns rely on.
SET @add_previous_pf_member = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'previous_pf_member') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `previous_pf_member` TINYINT(1) NULL DEFAULT NULL COMMENT ''1=was already an EPF member before joining, 0=first-time member, NULL=not recorded''',
  'DO 0');
PREPARE add_stmt FROM @add_previous_pf_member;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- =================================== 2. Existing / Previous EPS Member
--
-- A FOURTH STATUTORY FACT, AND A SEPARATE ONE. Official EPFO Form 11 puts the
-- question twice - "whether earlier a member of the Employees' Provident Fund
-- Scheme, 1952" and "whether earlier a member of the Employees' Pension
-- Scheme, 1995" - because the two have two answers.
--
-- WHY THE EPF ANSWER CANNOT STAND IN FOR THIS ONE. Somebody may have been an
-- EPF member without ever having been an EPS member: an international worker,
-- an excluded employee, or anybody who joined the fund above the pension wage
-- ceiling after the 2014 cutoff and was therefore kept out of EPS at that
-- employer too. Reading `previous_pf_member = 1` as prior EPS membership would
-- file those people into the pension scheme on an inference nobody made, so
-- the engine reads THIS column for the split and never the one above.
--
-- WHY PAYROLL NEEDS IT. Somebody who was not already an EPS member on or after
-- the 2014 cutoff, earning above the pension wage ceiling, cannot join EPS -
-- the employer's whole 12% goes to EPF instead of splitting into EPF and EPS.
-- The answer changes which statutory head the money is filed under, so it is
-- an input to the engine rather than a note on a profile.
--
-- TRI-STATE, NO BACKFILL, AND NOT DERIVED FROM ANYTHING. 1 yes, 0 no, NULL
-- nobody has said yet. There is deliberately no `UPDATE ... SET
-- previous_eps_member = previous_pf_member` here, and there never should be:
-- that statement is exactly the inference this column exists to stop. Where
-- the unknown can change a contribution, the engine reports it as unresolved
-- rather than guessing; and where it cannot - which is most employees, whose
-- Basic is under the ceiling - it costs nothing.
--
-- SAFE FOR THE NIGHTLY SYNC, for the same reason as the column above: it is
-- not a key the Digisme payload carries, so the 07:00 sync cannot set or clear
-- it.
SET @add_previous_eps_member = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'previous_eps_member') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `previous_eps_member` TINYINT(1) NULL DEFAULT NULL COMMENT ''1=was already an EPS member before joining, 0=never an EPS member, NULL=not recorded''',
  'DO 0');
PREPARE add_eps_stmt FROM @add_previous_eps_member;
EXECUTE add_eps_stmt;
DEALLOCATE PREPARE add_eps_stmt;

-- ============================================= 3. The salary history table
--
-- SALARY STOPS BEING A COLUMN. `new_employee.salary` is a free-text
-- VARCHAR(45) holding one number with no history, no effective date, no
-- breakup, no approval and no audit. It is left in place and untouched for
-- reference, and NOTHING in M2 reads it or copies from it - an opening salary
-- is entered deliberately, not inherited from a string nobody can date.
--
-- ONE ROW PER REVISION, AND ROWS ARE NEVER DELETED. A salary history that can
-- be deleted is not a history. There is no DELETE path in
-- `repository/employee_salary.js`, and a rejected revision stays on the record
-- as a rejected revision rather than disappearing.
--
-- WHY THE STATUTORY NUMBERS ARE STORED AND NOT DERIVED ON READ. The rates in
-- `config/statutory.js` are the rates NOW. A record written in 2026 has to
-- still explain itself in 2031, after a ceiling has moved - so each row keeps
-- both the amounts it produced and the `statutory_snapshot` that produced
-- them. Recomputing history against today's rates is how a payslip and a
-- filing quietly stop agreeing.
CREATE TABLE IF NOT EXISTS `employee_salary` (
  `salary_id`   INT AUTO_INCREMENT,
  `employee_id` INT NOT NULL,

  -- ---------------------------------------------------------- what HR types
  -- The ONE input. Everything below it is calculated by the server; nothing
  -- here is ever taken from a client.
  `monthly_gross` DECIMAL(12,2) NOT NULL COMMENT 'Monthly Gross for 26 salary days',
  `daily_salary`  DECIMAL(12,2) NOT NULL COMMENT 'monthly_gross / 26',

  -- ------------------------------------------------------- the four components
  -- There is no DA in this structure, deliberately. The four always sum to
  -- `monthly_gross` exactly - the engine computes them in paise so the
  -- identity holds rather than nearly holds.
  `basic`             DECIMAL(12,2) NOT NULL,
  `conveyance`        DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `hra`               DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `special_allowance` DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  -- ------------------------------------------------------------ the override
  -- A manual breakup redistributes a FIXED gross. Moving Basic moves the PF
  -- wage, which is a statutory consequence, so it needs a person's stated
  -- reason on the record and not just in a log.
  `manual_override` TINYINT(1) NOT NULL DEFAULT 0,
  `override_reason` VARCHAR(500) NULL DEFAULT NULL,

  -- -------------------------------------------------------- provident fund
  -- The PF wage basis is BASIC ONLY. `employer_epf` and `employer_eps` are
  -- NULL together when the pension split cannot be resolved - which does NOT
  -- make `employer_pf_total` unknown, because the employer pays 12% either
  -- way and only its division is in question.
  `pf_status`         ENUM('APPLIED','NOT_APPLICABLE','PENDING') NOT NULL,
  `pf_wage`           DECIMAL(12,2) NULL DEFAULT NULL,
  `employee_pf`       DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_pf_total` DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_epf`      DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_eps`      DECIMAL(12,2) NULL DEFAULT NULL,
  `edli`              DECIMAL(12,2) NULL DEFAULT NULL,
  `pf_admin_charge`   DECIMAL(12,2) NULL DEFAULT NULL,

  -- ------------------------------------------------------------------- ESI
  -- `esi_wage` IS NOT THE GROSS and is NULL until monthly payroll can supply
  -- the wage actually paid in a period. A PENDING status with NULL amounts is
  -- the honest answer; a contribution computed off the gross would be a
  -- plausible-looking number in a statutory return.
  `esi_status`   ENUM('APPLIED','NOT_APPLICABLE','PENDING') NOT NULL,
  `esi_wage`     DECIMAL(12,2) NULL DEFAULT NULL,
  `employee_esi` DECIMAL(12,2) NULL DEFAULT NULL,
  `employer_esi` DECIMAL(12,2) NULL DEFAULT NULL,

  -- ------------------------------------------------------------------- CTC
  -- Gross + the EMPLOYER's statutory costs. The employee's own PF and ESI are
  -- deductions from the gross and are already inside it; adding them again is
  -- the classic way to overstate a CTC. NULL whenever any employer cost is
  -- unresolved, because a CTC missing a component is not a CTC.
  `monthly_ctc` DECIMAL(12,2) NULL DEFAULT NULL,
  `ctc_status`  ENUM('APPLIED','PENDING') NOT NULL,

  -- --------------------------------------------------- what could not be decided
  -- The named reasons, machine-readable, so a screen can list exactly what is
  -- outstanding on a record instead of showing a blank amount.
  `unresolved_notes` JSON NULL DEFAULT NULL,

  -- ------------------------------------------------------------- the snapshot
  -- Enough statutory context to explain this row's arithmetic years later:
  -- every rate, ceiling, cap and rounding mode that produced it.
  `statutory_snapshot`       JSON NOT NULL,
  `statutory_config_version` VARCHAR(50) NOT NULL,

  -- ---------------------------------------------------- effective dating
  -- The date this structure starts applying from. A record is never edited
  -- into a different date range; a change is a new row.
  `effective_from` DATE NOT NULL,

  -- PENDING until somebody with the approval right decides. Neither PENDING
  -- nor REJECTED is ever current, and an APPROVED row dated in the future
  -- becomes current on its effective date and not before.
  `status` ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',

  -- Where the row came from. OPENING_SALARY is the first record for an
  -- employee; it is NOT a copy of the legacy `new_employee.salary`.
  `source` ENUM('OPENING_SALARY','REVISION','CORRECTION','IMPORT') NOT NULL,

  -- ----------------------------------------------------------------- audit
  -- Who created, approved or rejected this, and when. A rejection carries a
  -- reason for the same reason an override does: a decision nobody is named
  -- for, with no stated cause, is not an audit trail.
  `created_by`       INT NULL DEFAULT NULL,
  `created_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `approved_by`      INT NULL DEFAULT NULL,
  `approved_at`      TIMESTAMP NULL DEFAULT NULL,
  `rejected_by`      INT NULL DEFAULT NULL,
  `rejected_at`      TIMESTAMP NULL DEFAULT NULL,
  `rejection_reason` VARCHAR(500) NULL DEFAULT NULL,
  `updated_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- --------------------------------------- one live revision per date
  --
  -- The same trick `employee_period.open_marker` already uses in this schema:
  -- a generated column that is NULL for the rows the constraint must NOT
  -- apply to, because MySQL treats NULLs in a unique index as distinct.
  --
  -- So an employee may have exactly ONE non-rejected revision for any given
  -- effective date - a PENDING one or an APPROVED one, never both and never
  -- two - while any number of REJECTED rows may sit at that date, which is
  -- what lets a rejected proposal be re-proposed rather than blocking the date
  -- forever. The database enforces it, so a race between two approvers cannot
  -- produce two current salaries.
  `active_effective_from` DATE GENERATED ALWAYS AS
      (CASE WHEN `status` = 'REJECTED' THEN NULL ELSE `effective_from` END) STORED,

  PRIMARY KEY (`salary_id`),
  UNIQUE KEY `uq_salary_active_revision` (`employee_id`, `active_effective_from`),
  KEY `idx_salary_employee_effective` (`employee_id`, `effective_from`),
  -- The resolver's index: latest APPROVED row at or before a date.
  KEY `idx_salary_current` (`employee_id`, `status`, `effective_from`),
  KEY `idx_salary_status` (`status`),
  CONSTRAINT `fk_employee_salary_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =================================== 4. The designation permission catalogue
--
-- DECLARED HERE, GRANTED TO NOBODY.
--
-- These are the most powerful rights in the HR system: what everyone is paid,
-- and the authority to change it. The approved task is explicit that they must
-- not be broadly auto-granted, and the precedent this schema already sets for
-- powerful keys (`override_duplicate_bank_account`, `manage_biomax_devices`,
-- `export_statutory`) is to declare the key and grant it to no designation at
-- all. Administrators reach them through the `user_type = 2` bypass in
-- `middlewares/permissions.js`, which needs no row in `permissions`; everybody
-- else is granted them deliberately, one designation at a time, on the
-- Designation screen.
--
-- There is deliberately NO inheritance rule here - no "grant to whoever holds
-- add_employees". Recording somebody's PAN and deciding their pay are not the
-- same authority, and an inheritance rule is how the second quietly follows
-- the first onto thirty designations nobody re-examined.
--
-- NO PER-USER OVERRIDES. Permissions in this system are per DESIGNATION; the
-- `permissions` table has no user column and M2 does not add one.
--
--   view_salary                       read a salary structure and its history
--   add_salary                        propose an initial salary
--   edit_salary                       amend a PENDING proposal
--   manual_salary_component_override  depart from the automatic Basic
--   approve_salary_revision           approve or reject - the money decision
--   view_payroll                      the payroll section (M1 placeholder today)
--   process_payroll                   run a payroll period (not built in M2)
--   hr_reports                        HR / payroll reporting
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
              SELECT 'view_salary'                      AS `permission_key`
    UNION ALL SELECT 'add_salary'
    UNION ALL SELECT 'edit_salary'
    UNION ALL SELECT 'manual_salary_component_override'
    UNION ALL SELECT 'approve_salary_revision'
    UNION ALL SELECT 'view_payroll'
    UNION ALL SELECT 'process_payroll'
    UNION ALL SELECT 'hr_reports'
  ) k
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key` );
