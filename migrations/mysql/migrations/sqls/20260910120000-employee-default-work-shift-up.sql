-- Employee -> Work Shift, the manual mapping.
--
-- Phase 1 built `work_shift` and left every employee unmapped. This adds the
-- one column that holds the mapping, and nothing else.
--
-- ADDITIVE, AND DELIBERATELY EMPTY. `default_work_shift_id` starts NULL for
-- every existing employee and there is NO backfill: nothing here reads
-- `shift_master`, `new_employee.shift_id`, `new_employee.shift_code`, shift
-- names, shift times or anything Digisme synced. A guessed mapping is worse
-- than an absent one - it looks assigned, so nobody checks it - and payroll
-- would later pay against the guess. HR assigns every employee by hand.
--
-- THE LEGACY SHIFT IS UNTOUCHED. `new_employee.shift_id` keeps pointing at
-- `shift_master`, keeps its NOT NULL, and keeps serving the current system;
-- `shift_code` keeps taking whatever the Digisme sync writes. This column is
-- a second, independent mapping alongside them, not a replacement for either,
-- and no code path writes both.
--
-- NULLABLE IS THE POINT. "Unassigned" has to be representable: the column is
-- added to a table of employees nobody has mapped yet, and a NOT NULL with a
-- default would have to invent a shift for all of them.

ALTER TABLE `new_employee`
  ADD COLUMN `default_work_shift_id` INT NULL DEFAULT NULL
    COMMENT 'The payroll/attendance work shift. NULL = unassigned. Independent of the legacy shift_id.'
    AFTER `shift_code`;

-- The first foreign key on `new_employee`: `store_id`, `department_id`,
-- `designation_id` and `shift_id` are all unconstrained INTs. It validates
-- trivially on the way in, because every existing row is NULL and a NULL
-- child never has to match a parent.
--
-- ON DELETE RESTRICT, so a work shift that employees are mapped onto cannot
-- be deleted out from under them. SET NULL would silently unassign people and
-- the loss would surface as a payroll gap much later. In practice a shift is
-- retired by setting `active` = 0, which keeps history intact and is what the
-- UI offers; there is no delete endpoint for `work_shift` at all.
--
-- The constraint creates the index on `default_work_shift_id` that it needs,
-- so no separate index is declared here.
ALTER TABLE `new_employee`
  ADD CONSTRAINT `fk_new_employee_default_work_shift_id`
    FOREIGN KEY (`default_work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
