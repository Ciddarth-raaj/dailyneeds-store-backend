-- PAYROLL -> DOWNLOAD PAYSLIPS FOR HR.
--
-- `payroll_export_payslips` (20261122120000) was declared and granted to
-- nobody. The business owner has decided HR gets it - HR only, not Accounts:
-- the Download PDF button (one employee's payslip / F&F statement) and the
-- month's ZIP export.
--
-- 'HR EXECUTIVE' ONLY, by the one designation name this codebase already
-- relies on (as the Aadhaar and other grant migrations here do). The export
-- still requires view_employees + view_payroll + view_salary as well, and
-- never widens the holder's branch scope.
--
-- A row that exists but is INACTIVE is left alone: re-enabling a permission an
-- administrator switched off is their decision, not a migration's.
--
-- Additive and idempotent. No table, column or employee row is touched.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'payroll_export_payslips', d.`designation_id`, TRUE
    FROM `designation` d
   WHERE UPPER(TRIM(d.`designation_name`)) = 'HR EXECUTIVE'
     AND EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'payroll_export_payslips')
     AND NOT EXISTS (
       SELECT 1 FROM `permissions` p
        WHERE p.`permission_key` = 'payroll_export_payslips'
          AND p.`designation_id` = d.`designation_id` );
