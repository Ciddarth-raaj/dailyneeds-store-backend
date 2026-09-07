-- Permission keys for the Stage 0A admin flows. Granting them to a
-- designation is an administrator's decision in the app; nothing is granted
-- here. Each insert is idempotent so a re-run after a partial failure adds
-- nothing twice (all_permissions has no unique key on permission_key).
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_user_accounts' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_user_accounts');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'unlock_user_accounts' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'unlock_user_accounts');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_auth_log' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_auth_log');
