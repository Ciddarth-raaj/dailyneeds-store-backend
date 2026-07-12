DROP TABLE IF EXISTS pick_pack_returns;
DROP TABLE IF EXISTS pick_pack_return_remarks;

DELETE FROM `all_permissions` WHERE `permission_key` = 'view_pick_pack_return_remarks';
DELETE FROM `all_permissions` WHERE `permission_key` = 'add_pick_pack_return_remarks';
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_pick_pack_returns';
DELETE FROM `all_permissions` WHERE `permission_key` = 'add_pick_pack_returns';
