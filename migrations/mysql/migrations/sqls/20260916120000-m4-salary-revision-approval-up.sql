-- M4 — Salary Revision & Approval.
--
-- ONE NULLABLE COLUMN, AND NOTHING ELSE.
--
-- ADDITIVE AND RE-RUNNABLE. No salary row is written, no existing value
-- changes meaning, no permission is declared or granted, and
-- `new_employee.salary` is neither read nor touched — exactly as in M2. The
-- statement is guarded the same way the M2 migration guards its ALTERs,
-- because MySQL has no `ADD COLUMN IF NOT EXISTS` and a migration that cannot
-- be re-run is one that cannot be recovered halfway through.
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
-- SAFE FOR THE NIGHTLY SYNC. `services/synker.js` writes `new_employee` from
-- the Digisme payload and has never written `employee_salary` at all, so the
-- 07:00 sync can neither set nor clear this.
SET @add_revision_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'revision_reason') = 0,
  'ALTER TABLE `employee_salary` ADD COLUMN `revision_reason` VARCHAR(500) NULL DEFAULT NULL COMMENT ''Business reason for a REVISION/CORRECTION proposal. Separate from override_reason (why the breakup departs from the automatic one) and from rejection_reason (why an approver refused). NULL=not recorded.''',
  'DO 0');
PREPARE add_revision_reason_stmt FROM @add_revision_reason;
EXECUTE add_revision_reason_stmt;
DEALLOCATE PREPARE add_revision_reason_stmt;
