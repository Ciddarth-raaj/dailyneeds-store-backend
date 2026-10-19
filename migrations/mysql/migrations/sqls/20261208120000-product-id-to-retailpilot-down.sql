-- Undo of the up migration: every id back to its old code, using the map it
-- kept; product_sales' foreign key back; then the map and legacy_code go.
-- Products created after the switch (not in the map) keep their ids.
SET @rekey_fk_checks = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_table' AND COLUMN_NAME = 'variant_of') = 1,
  'UPDATE `product_table` x JOIN `product_id_rekey_map` m ON x.`variant_of` = m.`new_id` SET x.`variant_of` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_item' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_item` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_batch' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_batch` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_batch_data' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_batch_data` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_untagged_batches' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_untagged_batches` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_low_stock_warnings' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_low_stock_warnings` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_talker_group_items' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_talker_group_items` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_checker_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `price_checker_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_markupdown' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `item_markupdown` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`new_id` SET x.`item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offer_products' AND COLUMN_NAME = 'mosp_item_code') = 1,
  'UPDATE `offer_products` x JOIN `product_id_rekey_map` m ON x.`mosp_item_code` = m.`new_id` SET x.`mosp_item_code` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_images' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_images` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_image_log' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_image_log` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_prices' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_prices` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_stocks' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_stocks` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `invoice_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repack_items_master' AND COLUMN_NAME = 'item_id') = 1,
  'UPDATE `repack_items_master` x JOIN `product_id_rekey_map` m ON x.`item_id` = m.`new_id` SET x.`item_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_item' AND COLUMN_NAME = 'article_id') = 1,
  'UPDATE `purchase_item` x JOIN `product_id_rekey_map` m ON x.`article_id` = m.`new_id` SET x.`article_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_worksheet_item' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `job_worksheet_item` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_checker' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `stock_checker` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products_expiry_checker' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `products_expiry_checker` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sto_check' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `sto_check` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pick_pack_write_off' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `pick_pack_write_off` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pick_pack_returns' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `pick_pack_returns` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pick_pack_verifications' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `pick_pack_verifications` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dead_stock_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `dead_stock_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_holding_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `stock_holding_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grn_issue_ignores' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `grn_issue_ignores` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`new_id` SET x.`product_id` = m.`old_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

UPDATE `product_table` p JOIN `product_id_rekey_map` m ON p.`product_id` = m.`new_id`
   SET p.`product_id` = m.`old_id`;

COMMIT;
SET FOREIGN_KEY_CHECKS = @rekey_fk_checks;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'product_sales'
    AND CONSTRAINT_NAME = 'fk_product_sales_product') = 0,
  'ALTER TABLE `product_sales` ADD CONSTRAINT `fk_product_sales_product` FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

DROP TABLE `product_id_rekey_map`;

ALTER TABLE `product_table`
  DROP INDEX `idx_product_legacy_code`,
  DROP COLUMN `legacy_code`;
