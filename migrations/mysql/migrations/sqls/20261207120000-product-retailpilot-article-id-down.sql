DELETE FROM `permissions` WHERE `permission_key` = 'sync_retailpilot_stock';
DELETE FROM `all_permissions` WHERE `permission_key` = 'sync_retailpilot_stock';

ALTER TABLE `product_table`
  DROP INDEX `idx_product_retailpilot_article_id`,
  DROP COLUMN `retailpilot_article_id`;
