-- =====================================================================
-- Master -> Company Details: the permission key, and nothing else.
--
-- `company_details` already exists (20210929103343 + 20211004184520) and
-- its `status` column is what "Active for Payslip" means, so there is no
-- table change. This key gates every /company route and the menu entry. It
-- is DECLARED here and granted to NOBODY: administrators hold it through the
-- user_type 2 bypass, and a designation gets it only when somebody grants it
-- on the Designation screen.
-- =====================================================================
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_company_details' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'manage_company_details');
