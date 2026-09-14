-- Reverses only what the up-migration ADDED as structure. The backfilled
-- assignment-history rows are NOT deleted: they are append-only payroll
-- history, and by the time anybody rolls back, attendance may have been
-- calculated against them. Removing them would silently move settled
-- figures, which is the exact failure the history table exists to prevent.
ALTER TABLE `employee_aadhaar_identity` DROP COLUMN `name_as_per_aadhaar`;
ALTER TABLE `new_employee` DROP COLUMN `attendance_required`;
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_attendance_required';
