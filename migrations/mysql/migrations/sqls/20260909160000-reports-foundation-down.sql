-- Reports — reverse of the reports foundation.
--
-- Drops the two Reports tables and the three declared permissions. Saved
-- templates and the export audit trail go with them, which is correct before
-- the feature is in use and is a real loss of audit history afterwards - the
-- runbook note applies: once exports have been logged, rolling back discards
-- the record of who took what out of the building.
--
-- Nothing else is touched. No employee row, employee ID, lifecycle period,
-- Aadhaar record, bank verification or existing permission grant.

DROP TABLE IF EXISTS `report_export_log`;
DROP TABLE IF EXISTS `report_template`;

-- Only the keys this migration declared, and only where nobody was granted
-- one. A deliberate grant is not this file's to remove.
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('view_reports', 'export_reports', 'manage_shared_report_templates')
   AND NOT EXISTS (
     SELECT 1 FROM `permissions` p WHERE p.`permission_key` = `all_permissions`.`permission_key`
   );
