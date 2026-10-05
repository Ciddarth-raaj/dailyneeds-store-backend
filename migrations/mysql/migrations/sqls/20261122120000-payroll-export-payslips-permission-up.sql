-- =====================================================================
-- Payroll -> Calculation & Review: Download Payslips (bulk ZIP export).
--
-- The permission key, and nothing else. Exporting a month's payslips as a
-- ZIP is a separate act from reading one: it needs this key ON TOP of the
-- View Payslip keys (view_employees + view_payroll + view_salary), and it
-- never widens the caller's branch scope. Viewing or downloading ONE
-- employee's payslip is unchanged.
--
-- DECLARED here and granted to NOBODY: administrators hold it through the
-- user_type 2 bypass, and a designation gets it only when somebody grants it
-- on the Designation screen. No table is changed.
-- =====================================================================
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'payroll_export_payslips' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'payroll_export_payslips');
