DROP TABLE IF EXISTS `offers_v3_untagged_batches`;
DROP TABLE IF EXISTS `offers_v3_batch_data`;
DROP TABLE IF EXISTS `offers_v3_batch`;
DROP TABLE IF EXISTS `offers_v3_item`;

DELETE FROM `all_permissions` WHERE `permission_key` = 'add_offers_v3';
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_offers_v3';
