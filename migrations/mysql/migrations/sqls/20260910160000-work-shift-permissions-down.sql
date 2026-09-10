-- Reverses the five Work Shift permission keys.
--
-- Only the five keys this migration introduced, by name. Every other grant -
-- `view_shift`, `add_shifts`, `view_employees`, `employee_edit` and anything
-- an administrator granted by hand - is untouched.
--
-- Rolling back leaves the /work-shift and Employee Shift Assignment routes
-- asking for keys that no longer exist, which fails CLOSED: nobody but an
-- administrator can reach them. Restoring the previous behaviour means
-- deploying the previous code too, which is what a rollback is.
DELETE FROM `permissions` WHERE `permission_key` IN (
  'view_work_shifts',
  'manage_work_shifts',
  'view_shift_assignments',
  'assign_employee_shift',
  'bulk_assign_employee_shift'
);
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_work_shifts',
  'manage_work_shifts',
  'view_shift_assignments',
  'assign_employee_shift',
  'bulk_assign_employee_shift'
);
