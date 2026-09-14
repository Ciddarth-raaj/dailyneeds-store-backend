-- Reverses the declaration and the grant, and nothing else.
--
-- `employee_scope_all_branches` IS NOT TOUCHED. HR keeps its company-wide
-- employee scope on the way down - that key is a separate decision and was
-- granted by a separate migration.
DELETE FROM `permissions`
 WHERE `permission_key` = 'view_hr_onboarding_dashboard';

DELETE FROM `all_permissions`
 WHERE `permission_key` = 'view_hr_onboarding_dashboard';
