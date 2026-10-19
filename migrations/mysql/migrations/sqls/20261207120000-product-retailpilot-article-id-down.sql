DELETE FROM `permissions` WHERE `permission_key` = 'sync_retailpilot_stock';
DELETE FROM `all_permissions` WHERE `permission_key` = 'sync_retailpilot_stock';

DROP TABLE IF EXISTS `retailpilot_hierarchy_map`;

ALTER TABLE `product_table`
  DROP INDEX `idx_product_retailpilot_article_id`,
  DROP COLUMN `retailpilot_article_id`;
