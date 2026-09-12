-- Reverses 20260917120000 exactly: the table this migration created, and
-- nothing else. `new_employee.default_work_shift_id` was never touched on the
-- way up, so there is nothing to restore on it.
DROP TABLE IF EXISTS `employee_work_shift_assignment`;

-- Review fix #2: the work shift configuration history. Dropped whole; the live
-- `work_shift` and `work_shift_weekly_schedule` tables were never altered on
-- the way up, so there is nothing to restore on them either.
DROP TABLE IF EXISTS `work_shift_config_version`;

-- The correction permission key. The grant table is not touched: this
-- migration granted the key to nobody, so there is no grant to remove.
DELETE FROM `all_permissions` WHERE `permission_key` = 'correct_employee_shift_assignment';
