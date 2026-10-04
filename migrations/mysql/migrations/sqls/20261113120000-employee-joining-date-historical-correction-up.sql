-- =====================================================================
-- Historical joining-date correction: the permission key, and nothing else.
--
-- A joining date being recorded must be within 30 days either side of today
-- (utils/joining_date_window.js). This key lets the dedicated joining-date
-- correction and bulk update record an OLDER date - with a mandatory reason,
-- audited on employee_lifecycle_event. It is DECLARED here and granted to
-- NOBODY: administrators hold it through the user_type 2 bypass, and a
-- designation gets it only when somebody grants it on the Designation screen.
--
-- No table changes: the audit is the existing lifecycle event's detail_json.
-- =====================================================================
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'employee_joining_date_historical_correction' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'employee_joining_date_historical_correction');
