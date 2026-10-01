-- Reverses 20261109110000-transporter-master-up.sql. Runs after the LR
-- Follow-up migration's down, which drops the tables that reference it.
DROP TABLE IF EXISTS transporter_master_audit;
DROP TABLE IF EXISTS transporter_master;

DELETE FROM `permissions` WHERE `permission_key` IN (
  'view_transporter_master', 'create_transporter_master', 'edit_transporter_master'
);
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_transporter_master', 'create_transporter_master', 'edit_transporter_master'
);
