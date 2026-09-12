-- Reverses 20260923120000. Historical role-based steps carry NULL in the
-- dropped columns, so nothing about them is lost. The appended 'EMPLOYEE'
-- value on `attendance_approval_step.approver_role` is deliberately LEFT IN
-- PLACE: narrowing the ENUM would rewrite or refuse any employee-level step
-- created while the feature was live, and a wider ENUM harms nothing.
DELETE FROM `permissions`     WHERE `permission_key` = 'manage_attendance_approvers';
DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_approvers';

ALTER TABLE `attendance_approval_request` DROP COLUMN `chain_source`;
ALTER TABLE `attendance_approval_step` DROP INDEX `idx_aas_approver_employee`;
ALTER TABLE `attendance_approval_step` DROP COLUMN `approval_level`;
ALTER TABLE `attendance_approval_step` DROP COLUMN `approver_employee_id`;

DROP TABLE IF EXISTS `attendance_approver_setup_audit`;
DROP TABLE IF EXISTS `attendance_approver_setup`;
