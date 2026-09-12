-- M4 — Salary Revision & Approval.
--
-- FOUR NULLABLE COLUMNS AND ONE UNIQUE KEY, AND NOTHING ELSE.
--
--   1. `revision_reason`          why a proposal is changing somebody's pay
--   2. `changed_by`/`changed_at`  who amended a PENDING proposal, and when
--   3. `pending_proposal_marker`  a generated marker, plus the unique key on
--                                 it: at most ONE pending proposal per employee
--
-- ADDITIVE AND RE-RUNNABLE. No salary row is written, rewritten or deleted, no
-- existing value changes meaning, no permission is declared or granted, and
-- `new_employee.salary` is neither read nor touched — exactly as in M2. Every
-- statement is guarded the same way the M2 migration guards its ALTERs,
-- because MySQL has no `ADD COLUMN IF NOT EXISTS` and a migration that cannot
-- be re-run is one that cannot be recovered halfway through.
--
-- NOTHING HERE INVENTS DATA. There is no backfill, no default and no UPDATE:
-- a column added today is NULL for every row that predates it, and NULL is the
-- honest answer. Where the new unique key cannot be applied because two
-- undecided proposals already exist for one employee, the migration FAILS and
-- says so rather than deciding which of somebody's two pay proposals to
-- discard — see section 3 and the runner beside this file.
--
-- M4 IS NOT DEPLOYED, so this file is edited rather than chased with a second
-- migration; it still applies cleanly to a production database sitting at M2.
--
-- WHY M4 NEEDS A COLUMN AT ALL. A revision is a decision about somebody's pay
-- that an approver has to agree to, and "why" is the first thing they ask. M2
-- had nowhere to put that answer, so the business reason lived only in
-- whoever's head proposed it.
--
-- WHY NOT `override_reason`. That one means something else and is already
-- taken: it is the stated cause for departing from the AUTOMATIC breakup —
-- for moving Basic, and therefore the PF wage, by hand. Most revisions carry
-- no override at all, and a record that overloaded the two would be unable to
-- answer either question: "increment at annual review" is not a reason to
-- redistribute a gross, and "Basic held at last year's figure" is not a reason
-- to raise pay. They stay two columns and M4 keeps them two fields on screen.
--
-- WHY NOT `rejection_reason`. That is the APPROVER's reason for refusing, and
-- it is written at rejection time by somebody else. Reusing it would mean a
-- proposal's own justification being overwritten by its refusal.
--
-- NULLABLE, WITH NO BACKFILL AND NO DEFAULT. Every salary row that exists
-- before this migration was created without the field, and inventing a reason
-- for a decision somebody else made is precisely the kind of assertion a
-- migration must never make. NULL here reads as "not recorded", the same way
-- it does on `previous_pf_member`.
--
-- REQUIRED-NESS IS A BUSINESS RULE, NOT A SCHEMA ONE, and it lives in
-- `usecase/employee_salary.js`: a REVISION or a CORRECTION must carry a
-- non-blank reason, an OPENING_SALARY need not, because the first salary an
-- employee is put on is not a change to anything. A `NOT NULL` column would
-- have to be either wrong for opening salaries or backfilled with a sentence
-- nobody wrote.
--
-- VARCHAR(500), matching `override_reason` and `rejection_reason` beside it,
-- so the three reason fields on one row have one length between them.
--
-- SAFE FOR THE NIGHTLY SYNC. `services/synker.js` writes the employee master
-- from the Digisme payload and has never written `employee_salary` at all, so
-- the 07:00 sync can neither set nor clear this.
--
-- ========================================== 1. The proposer's reason
SET @add_revision_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'revision_reason') = 0,
  'ALTER TABLE `employee_salary` ADD COLUMN `revision_reason` VARCHAR(500) NULL DEFAULT NULL COMMENT ''Business reason for a REVISION/CORRECTION proposal. Separate from override_reason (why the breakup departs from the automatic one) and from rejection_reason (why an approver refused). NULL=not recorded.''',
  'DO 0');
PREPARE add_revision_reason_stmt FROM @add_revision_reason;
EXECUTE add_revision_reason_stmt;
DEALLOCATE PREPARE add_revision_reason_stmt;

-- ===================================== 2. WHO AMENDED A PENDING PROPOSAL
--
-- A SEPARATE AUDIT FACT FROM `updated_at`, AND THAT IS THE WHOLE POINT.
--
-- The finalized audit requirement is Created / Changed / Approved / Rejected,
-- each with an actor and a time. Three of the four were already on the row.
-- The fourth was not: `updated_at` is `ON UPDATE CURRENT_TIMESTAMP`, so it
-- moves when a proposal is APPROVED and when it is REJECTED just as readily as
-- when somebody amends it, and it names nobody at all. Reading it as "when was
-- this changed" would report the approval time of every approved revision as
-- an amendment that never happened.
--
-- So the amendment gets its own two columns, written by exactly one code path
-- (`updatePendingSalary`) and by nothing else. Approval and rejection do not
-- touch them - `repository/employee_salary.js#approve` and `#reject` name the
-- columns they set, and these are not among them - so a proposal that was
-- approved without ever being amended keeps NULL here and the screen shows no
-- Changed line for it, which is the truth.
--
-- `updated_at` IS LEFT EXACTLY AS IT IS and keeps its generic meaning: the
-- last time this row changed for any reason. It is not repurposed, and nothing
-- reads it as an amendment time.
--
-- NULLABLE, NO BACKFILL, NO DEFAULT. A row created and never amended has NULL
-- here and must: inventing an amendment - or an amender - for a revision that
-- only ever had one version is the same false assertion a backfilled reason
-- would be. NULL reads as "never amended".
SET @add_changed_by = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'changed_by') = 0,
  'ALTER TABLE `employee_salary` ADD COLUMN `changed_by` INT NULL DEFAULT NULL COMMENT ''Employee who last amended this proposal while it was PENDING. NULL=never amended. Not written by approval or rejection.''',
  'DO 0');
PREPARE add_changed_by_stmt FROM @add_changed_by;
EXECUTE add_changed_by_stmt;
DEALLOCATE PREPARE add_changed_by_stmt;

SET @add_changed_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'changed_at') = 0,
  'ALTER TABLE `employee_salary` ADD COLUMN `changed_at` TIMESTAMP NULL DEFAULT NULL COMMENT ''When this proposal was last amended while PENDING. NULL=never amended. Distinct from updated_at, which also moves on approval and rejection.''',
  'DO 0');
PREPARE add_changed_at_stmt FROM @add_changed_at;
EXECUTE add_changed_at_stmt;
DEALLOCATE PREPARE add_changed_at_stmt;

-- ================================ 3. ONE PENDING PROPOSAL PER EMPLOYEE
--
-- THE BUSINESS RULE, AS THE DATABASE SEES IT. A salary proposal is one
-- decision at a time: an employee may have AT MOST ONE PENDING proposal,
-- whatever its effective date. A second one is not a queue, it is two
-- different answers to "what is this person going to be paid" with nobody
-- having said which. The proposal in hand is amended, approved or rejected
-- before another is raised.
--
-- WHY THE DATABASE AND NOT ONLY THE SERVICE. `usecase/employee_salary.js`
-- refuses the second proposal with a sentence somebody can act on, and that is
-- the answer a person gets. But a check-then-insert in application code is a
-- race: two requests that both read "no pending proposal" a millisecond apart
-- both go on to insert one. The unique key is the backstop that makes the
-- invariant true rather than usually true.
--
-- THE SAME PATTERN THE ROW ALREADY USES. `active_effective_from` (M2) is a
-- generated column that is NULL for the rows its constraint must not apply to,
-- because MySQL treats NULLs in a unique index as distinct. This is that trick
-- again for a different question: the marker is 1 for a PENDING row and NULL
-- for every APPROVED or REJECTED one, so an employee may accumulate any number
-- of decided rows - which is what a salary history IS - while only ever having
-- one undecided one.
--
-- IT CONSTRAINS NOTHING ELSE. Rejected proposals never block a new one.
-- Approved history is permanent and untouched. The M2 rule that an employee
-- may not hold two live revisions at one effective date, and the M2 rule that
-- refuses a second future-dated live revision, both stand exactly as they
-- were: this is an additional invariant, not a replacement for either.
--
-- GENERATED AND STORED, NOT WRITTEN. Nothing may set this column - it is
-- derived from `status` by the database itself, so it cannot drift out of
-- agreement with the status it describes, and no INSERT or UPDATE anywhere in
-- the codebase names it.
SET @add_pending_marker = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'pending_proposal_marker') = 0,
  'ALTER TABLE `employee_salary` ADD COLUMN `pending_proposal_marker` TINYINT GENERATED ALWAYS AS (CASE WHEN `status` = ''PENDING'' THEN 1 ELSE NULL END) STORED COMMENT ''1 for a PENDING row, NULL otherwise. Exists only to carry uq_salary_pending_proposal. NULLs are distinct in a unique index, so decided rows never collide.''',
  'DO 0');
PREPARE add_pending_marker_stmt FROM @add_pending_marker;
EXECUTE add_pending_marker_stmt;
DEALLOCATE PREPARE add_pending_marker_stmt;

-- THE INDEX ITSELF.
--
-- Guarded on its own absence, so the file re-runs. If two PENDING rows for one
-- employee somehow already exist when this runs, THIS STATEMENT FAILS and the
-- migration stops - which is the correct outcome and is deliberate. The
-- migration does not reject one of them, does not delete one, and does not
-- merge them: choosing which of two undecided pay proposals survives is a
-- business decision about somebody's salary, and a migration that made it
-- silently would be mutating a history nobody asked it to touch. The runner
-- beside this file checks for that case first so the failure names the
-- employees rather than a duplicate key, and either way the data is left for a
-- person to resolve deliberately.
SET @add_pending_unique = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `INDEX_NAME` = 'uq_salary_pending_proposal') = 0,
  'ALTER TABLE `employee_salary` ADD UNIQUE KEY `uq_salary_pending_proposal` (`employee_id`, `pending_proposal_marker`)',
  'DO 0');
PREPARE add_pending_unique_stmt FROM @add_pending_unique;
EXECUTE add_pending_unique_stmt;
DEALLOCATE PREPARE add_pending_unique_stmt;
