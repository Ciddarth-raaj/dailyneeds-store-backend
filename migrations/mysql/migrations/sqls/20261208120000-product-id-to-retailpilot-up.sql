-- =====================================================================
-- One-time switch of every product's id to RetailPilot's article id.
--
-- product_table.product_id was the old GoFrugal / Delium item code
-- (2-52,018). It becomes RetailPilot's article id (100,001+, the value the
-- daily RetailPilot sync stored in retailpilot_article_id), and the old code
-- is kept in the new legacy_code column. Every column holding a product id
-- moves with it, through one map (product_id_rekey_map), in one transaction.
--
-- Left on the old code on purpose, and read through legacy_code
-- (utils/legacy_item_codes.js):
--   - product_sales and stock_holding_items: sales and stock-holding history
--     from before RetailPilot. Their foreign keys to product_table are
--     dropped, since their codes are no longer product ids.
--   - the frozen GoFrugal copy (medishopdb_*).
--
-- The two ranges never meet, so no row is ever briefly given another
-- product's id. Most foreign keys to product_table do not cascade on
-- update, so foreign key checks are off while the ids move and every
-- column, linked or not, is updated explicitly. A column that does not
-- exist in this database is skipped.
--
-- GUARDS run before anything changes: each fails with error 1242
-- ("Subquery returns more than 1 row") and stops the migration. The map is
-- kept afterwards, for the down migration and for reference.
-- =====================================================================

-- GUARD 1: the RetailPilot sync must have run, giving most products their
-- RetailPilot id.
SELECT (
  SELECT 'fewer than 20000 products have a RetailPilot id - run the RetailPilot product sync first'
  FROM (SELECT 1 AS n UNION ALL SELECT 2) AS fail_twice
  WHERE (SELECT COUNT(*) FROM `product_table` WHERE `retailpilot_article_id` IS NOT NULL) < 20000
) AS rekey_guard_synced;

-- GUARD 2: no two products share a RetailPilot id.
SELECT (
  SELECT 'two products have the same RetailPilot id'
  FROM (SELECT 1 AS n UNION ALL SELECT 2) AS fail_twice
  WHERE EXISTS (
    SELECT `retailpilot_article_id` FROM `product_table`
     WHERE `retailpilot_article_id` IS NOT NULL
     GROUP BY `retailpilot_article_id` HAVING COUNT(*) > 1
  )
) AS rekey_guard_unique;

-- GUARD 3: every product being moved has an old code (below 100001), and
-- every new id is free.
SELECT (
  SELECT 'a product id to move is not an old code, or its RetailPilot id is already another product'
  FROM (SELECT 1 AS n UNION ALL SELECT 2) AS fail_twice
  WHERE EXISTS (
    SELECT 1 FROM `product_table` p
     WHERE p.`retailpilot_article_id` IS NOT NULL AND p.`retailpilot_article_id` <> p.`product_id`
       AND (p.`product_id` >= 100001 OR p.`retailpilot_article_id` < 100001
            OR EXISTS (SELECT 1 FROM `product_table` q WHERE q.`product_id` = p.`retailpilot_article_id`))
  )
) AS rekey_guard_ranges;

ALTER TABLE `product_table`
  ADD COLUMN `legacy_code` INT NULL DEFAULT NULL,
  ADD KEY `idx_product_legacy_code` (`legacy_code`);

-- product_sales and stock_holding_items keep the old code: they can no longer
-- point at product_table.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'product_sales'
    AND CONSTRAINT_NAME = 'fk_product_sales_product' AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1,
  'ALTER TABLE `product_sales` DROP FOREIGN KEY `fk_product_sales_product`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_holding_items'
    AND CONSTRAINT_NAME = 'fk_stock_holding_items_product' AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 1,
  'ALTER TABLE `stock_holding_items` DROP FOREIGN KEY `fk_stock_holding_items_product`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

CREATE TABLE `product_id_rekey_map` (
  `old_id` INT NOT NULL,
  `new_id` INT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`old_id`),
  UNIQUE KEY `uq_product_id_rekey_new` (`new_id`)
) ENGINE=InnoDB;

INSERT INTO `product_id_rekey_map` (`old_id`, `new_id`)
  SELECT `product_id`, `retailpilot_article_id` FROM `product_table`
   WHERE `retailpilot_article_id` IS NOT NULL AND `retailpilot_article_id` <> `product_id`;

SET @rekey_fk_checks = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;

-- Every old code is kept, moved or not.
UPDATE `product_table` SET `legacy_code` = `product_id` WHERE `product_id` < 100001;

-- Every column holding a product id, linked by a foreign key or not.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_table' AND COLUMN_NAME = 'variant_of') = 1,
  'UPDATE `product_table` x JOIN `product_id_rekey_map` m ON x.`variant_of` = m.`old_id` SET x.`variant_of` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_item' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_item` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_batch' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_batch` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_batch_data' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_batch_data` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_untagged_batches' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_untagged_batches` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_low_stock_warnings' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_low_stock_warnings` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offers_v3_talker_group_items' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `offers_v3_talker_group_items` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_checker_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `price_checker_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_markupdown' AND COLUMN_NAME = 'item_code') = 1,
  'UPDATE `item_markupdown` x JOIN `product_id_rekey_map` m ON x.`item_code` = m.`old_id` SET x.`item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offer_products' AND COLUMN_NAME = 'mosp_item_code') = 1,
  'UPDATE `offer_products` x JOIN `product_id_rekey_map` m ON x.`mosp_item_code` = m.`old_id` SET x.`mosp_item_code` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_images' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_images` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_image_log' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_image_log` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_prices' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_prices` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_stocks' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `product_stocks` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `invoice_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repack_items_master' AND COLUMN_NAME = 'item_id') = 1,
  'UPDATE `repack_items_master` x JOIN `product_id_rekey_map` m ON x.`item_id` = m.`old_id` SET x.`item_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_item' AND COLUMN_NAME = 'article_id') = 1,
  'UPDATE `purchase_item` x JOIN `product_id_rekey_map` m ON x.`article_id` = m.`old_id` SET x.`article_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_worksheet_item' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `job_worksheet_item` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_checker' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `stock_checker` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products_expiry_checker' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `products_expiry_checker` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sto_check' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `sto_check` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pick_pack_write_off' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `pick_pack_write_off` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pick_pack_returns' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `pick_pack_returns` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pick_pack_verifications' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `pick_pack_verifications` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dead_stock_items' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `dead_stock_items` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grn_issue_ignores' AND COLUMN_NAME = 'product_id') = 1,
  'UPDATE `grn_issue_ignores` x JOIN `product_id_rekey_map` m ON x.`product_id` = m.`old_id` SET x.`product_id` = m.`new_id`', 'DO 0');
PREPARE rekey_stmt FROM @sql; EXECUTE rekey_stmt; DEALLOCATE PREPARE rekey_stmt;

UPDATE `product_table` p JOIN `product_id_rekey_map` m ON p.`product_id` = m.`old_id`
   SET p.`product_id` = m.`new_id`;

-- GUARD 4: every mapped product now has its new id.
SELECT (
  SELECT 'not every product moved to its RetailPilot id'
  FROM (SELECT 1 AS n UNION ALL SELECT 2) AS fail_twice
  WHERE (SELECT COUNT(*) FROM `product_table` p JOIN `product_id_rekey_map` m ON p.`product_id` = m.`new_id`)
     <> (SELECT COUNT(*) FROM `product_id_rekey_map`)
) AS rekey_guard_moved;

COMMIT;
SET FOREIGN_KEY_CHECKS = @rekey_fk_checks;
