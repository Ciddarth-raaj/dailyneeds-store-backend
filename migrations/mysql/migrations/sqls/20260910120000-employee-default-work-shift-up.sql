-- Employee -> Work Shift, the NEW manual mapping. ADDITIVE ONLY.
--
-- One nullable column and one foreign key. No employee row is written, no
-- value is copied from anywhere, and nothing existing changes meaning.
--
-- WHY A SECOND COLUMN RATHER THAN REPOINTING `shift_id`.
-- `new_employee.shift_id` points at the legacy `shift_master` table and is
-- what the live system still reads. `new_employee.shift_code` is a THIRD
-- thing again: the nightly Digisme sync overwrites it and it has never been
-- resolved to a `shift_master.shift_id`, so the two already disagree (see
-- docs/hr-schema.md). Repointing either at `work_shift` would change what a
-- live column means. This adds a column beside them instead, and leaves both
-- exactly as they are.
--
-- NO BACKFILL, AND NOT BY OMISSION. There is deliberately no UPDATE here.
-- Nothing is matched from `shift_master`, from `shift_code`, from shift names
-- or times, or from Digisme. Every existing employee starts Unassigned on the
-- new mapping and HR assigns them by hand. Any automatic guess would be a
-- payroll-affecting decision made by a migration, which is the one place it
-- could never be reviewed.
--
-- SAFE FOR THE NIGHTLY SYNC. `services/synker.js` builds its
-- `INSERT ... ON DUPLICATE KEY UPDATE` from the keys present in the Digisme
-- payload, and `default_work_shift_id` is not one of them, so the sync can
-- neither set nor clear this column. A locally assigned work shift survives
-- 07:00 the way `salary` and the bank columns already do.
--
-- ON DELETE RESTRICT is the safe direction: a work shift that employees are
-- mapped to cannot be deleted out from under them. It costs nothing in
-- practice - there is no delete for a work shift, on the API or in the UI;
-- a shift that stops being used is set inactive and keeps its schedule.
--
-- The index is declared explicitly rather than left to MySQL's implicit
-- foreign-key index, so it has a name that says what it is; the constraint
-- then reuses it. It is also the index the assignment screen's
-- ASSIGNED/UNASSIGNED filter reads.
--
-- One ALTER statement, so it either lands whole or not at all.
ALTER TABLE `new_employee`
  ADD COLUMN `default_work_shift_id` INT NULL DEFAULT NULL
    COMMENT 'The new payroll/attendance work shift. NULL = unassigned. Separate from the legacy shift_id/shift_code.',
  ADD INDEX `idx_new_employee_default_work_shift` (`default_work_shift_id`),
  ADD CONSTRAINT `fk_new_employee_default_work_shift`
    FOREIGN KEY (`default_work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
