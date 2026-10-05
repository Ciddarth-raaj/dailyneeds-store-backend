-- Removes the key and any grant of it made since. No payslip is touched.
DELETE FROM `permissions` WHERE `permission_key` = 'payroll_export_payslips';
DELETE FROM `all_permissions` WHERE `permission_key` = 'payroll_export_payslips';
