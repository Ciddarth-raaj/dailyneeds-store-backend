DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_ot_auto_approval';
ALTER TABLE `attendance_ot_auto_pending_setting` DROP COLUMN `auto_approve_updated_by`;
