DELETE FROM `permissions` WHERE `permission_key` IN ('manage_stock_audit_roles', 'approve_stock_audit_exclusions');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('manage_stock_audit_roles', 'approve_stock_audit_exclusions');
DROP TABLE IF EXISTS `sa_role_assignment`;
DROP TABLE IF EXISTS `sa_employee_exclusion`;
DROP TABLE IF EXISTS `sa_cycle_employee`;
DROP TABLE IF EXISTS `sa_cycle_snapshot`;
DROP TABLE IF EXISTS `sa_setting_history`;
DROP TABLE IF EXISTS `sa_setting`;
