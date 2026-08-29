DROP TABLE IF EXISTS `offers_v3`;

DELETE FROM `all_permissions` WHERE `permission_key` = 'add_offers_v3';
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_offers_v3';
