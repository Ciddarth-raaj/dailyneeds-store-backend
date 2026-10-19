DELETE FROM `permissions` WHERE `permission_key` = 'sync_retailpilot_stock';
DELETE FROM `all_permissions` WHERE `permission_key` = 'sync_retailpilot_stock';

DROP TABLE IF EXISTS `rp_sync_state`;
DROP TABLE IF EXISTS `rp_batch_prices`;
DROP TABLE IF EXISTS `rp_batch_stock`;
DROP TABLE IF EXISTS `rp_batches`;
DROP TABLE IF EXISTS `rp_vendors`;
DROP TABLE IF EXISTS `rp_stores`;
DROP TABLE IF EXISTS `rp_article_eans`;
DROP TABLE IF EXISTS `rp_hierarchy`;
DROP TABLE IF EXISTS `rp_articles`;
