-- Reverses 20260917120000 exactly: the table this migration created, and
-- nothing else. `new_employee.default_work_shift_id` was never touched on the
-- way up, so there is nothing to restore on it.
DROP TABLE IF EXISTS `employee_work_shift_assignment`;
