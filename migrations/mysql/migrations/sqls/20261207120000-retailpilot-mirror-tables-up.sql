-- =====================================================================
-- RetailPilot mirror: copies of RetailPilot's item, hierarchy, store,
-- vendor, batch, stock and selling-price tables, keyed on RetailPilot's own
-- ids and filled by the daily RetailPilot sync (6:00 Asia/Kolkata). The old
-- product tables (product_table, categories, brands, ...) are not touched;
-- features built from now on read these.
--
-- rp_updated_at / row_hash are RetailPilot's; synced_at is when we last
-- wrote the row, and sync_run is the run that last saw it (rows a full
-- refresh did not see are deleted by that run).
-- =====================================================================

CREATE TABLE IF NOT EXISTS `rp_articles` (
  `article_id` INT NOT NULL,
  `old_item_code` INT NULL DEFAULT NULL,
  `article_name` VARCHAR(500) NULL,
  `description` TEXT NULL,
  `preparation_type` VARCHAR(50) NULL,
  `purchase_measure` VARCHAR(30) NULL,
  `sales_measure` VARCHAR(30) NULL,
  `scale` DECIMAL(15,4) NULL,
  `precision_digits` INT NULL,
  `is_reversible` TINYINT(1) NULL,
  `hsn_code` VARCHAR(30) NULL,
  `ready` TINYINT(1) NULL,
  `vertical` VARCHAR(30) NULL,
  `mrp` DECIMAL(15,2) NULL,
  `trade_price` DECIMAL(15,4) NULL,
  `plu_id` VARCHAR(50) NULL,
  `department_id` INT NULL,
  `category_id` INT NULL,
  `subcategory_id` INT NULL,
  `brand_id` INT NULL,
  `manufacturer_id` INT NULL,
  `rp_created_at` DATETIME NULL,
  `rp_updated_at` DATETIME NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`article_id`),
  KEY `idx_rp_articles_old_item_code` (`old_item_code`),
  KEY `idx_rp_articles_category` (`category_id`),
  KEY `idx_rp_articles_brand` (`brand_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- level: department / category / subcategory / brand / manufacturer
CREATE TABLE IF NOT EXISTS `rp_hierarchy` (
  `level` VARCHAR(20) NOT NULL,
  `hierarchy_id` INT NOT NULL,
  `name` VARCHAR(255) NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`level`, `hierarchy_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `rp_article_eans` (
  `ean` VARCHAR(50) NOT NULL,
  `article_id` INT NOT NULL,
  `enabled` TINYINT(1) NULL,
  `is_auto_generated` TINYINT(1) NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ean`, `article_id`),
  KEY `idx_rp_article_eans_article` (`article_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- outlet_id is resolved through Branch Master (outlets.retailpilot_id).
CREATE TABLE IF NOT EXISTS `rp_stores` (
  `store_id` VARCHAR(20) NOT NULL,
  `name` VARCHAR(255) NULL,
  `shortname` VARCHAR(100) NULL,
  `type` VARCHAR(30) NULL,
  `entity_id` VARCHAR(30) NULL,
  `is_active` TINYINT(1) NULL,
  `external_id` VARCHAR(50) NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `rp_vendors` (
  `vendor_id` VARCHAR(20) NOT NULL,
  `name` VARCHAR(255) NULL,
  `trade_name` VARCHAR(255) NULL,
  `tax_id` VARCHAR(30) NULL,
  `is_active` TINYINT(1) NULL,
  `external_id` VARCHAR(50) NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `rp_batches` (
  `batch_id` VARCHAR(64) NOT NULL,
  `article_id` INT NOT NULL,
  `store_id` VARCHAR(20) NULL,
  `supplier_id` VARCHAR(20) NULL,
  `initial_stock` DECIMAL(15,3) NULL,
  `mrp` DECIMAL(15,2) NULL,
  `basic_cost` DECIMAL(15,4) NULL,
  `discount_value` DECIMAL(15,2) NULL,
  `net_cost` DECIMAL(15,4) NULL,
  `tax_perc` DECIMAL(5,2) NULL,
  `landing_cost` DECIMAL(15,4) NULL,
  `net_landing_cost` DECIMAL(15,4) NULL,
  `hsn_code` VARCHAR(30) NULL,
  `supplier_batch_number` VARCHAR(100) NULL,
  `manufacture_date` DATE NULL,
  `expiry_date` DATE NULL,
  `tags` VARCHAR(1000) NULL,
  `invoice_detail_slug` VARCHAR(50) NULL,
  `rp_created_at` DATETIME NULL,
  `rp_updated_at` DATETIME NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`),
  KEY `idx_rp_batches_article` (`article_id`),
  KEY `idx_rp_batches_updated` (`rp_updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Current stock, refreshed in full every run; only non-zero positions.
CREATE TABLE IF NOT EXISTS `rp_batch_stock` (
  `batch_id` VARCHAR(64) NOT NULL,
  `store_id` VARCHAR(20) NOT NULL,
  `stock_location` VARCHAR(30) NOT NULL,
  `article_id` INT NOT NULL,
  `quantity` DECIMAL(15,3) NOT NULL,
  `rp_updated_at` DATETIME NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`, `store_id`, `stock_location`),
  KEY `idx_rp_batch_stock_article` (`article_id`),
  KEY `idx_rp_batch_stock_store` (`store_id`),
  KEY `idx_rp_batch_stock_run` (`sync_run`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- store_id / channel_type / customer_type NULL = applies to all.
CREATE TABLE IF NOT EXISTS `rp_batch_prices` (
  `price_id` VARCHAR(32) NOT NULL,
  `batch_id` VARCHAR(64) NOT NULL,
  `store_id` VARCHAR(20) NULL,
  `channel_type` VARCHAR(20) NULL,
  `customer_type` VARCHAR(20) NULL,
  `selling_price` DECIMAL(15,4) NULL,
  `rp_updated_at` DATETIME NULL,
  `row_hash` CHAR(32) NULL,
  `sync_run` VARCHAR(32) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`price_id`),
  KEY `idx_rp_batch_prices_batch` (`batch_id`),
  KEY `idx_rp_batch_prices_updated` (`rp_updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per mirrored table: when it was last pulled, and whether a full
-- load has completed (the incremental tables pull only recent changes after).
CREATE TABLE IF NOT EXISTS `rp_sync_state` (
  `table_name` VARCHAR(40) NOT NULL,
  `last_run_at` DATETIME NULL,
  `last_full_at` DATETIME NULL,
  `last_rows` INT NULL,
  `last_error` TEXT NULL,
  PRIMARY KEY (`table_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- POST /retailpilot/sync (run the sync by hand, or a dry run). Declared and
-- granted to nobody, like sync_retailpilot_purchases; the scheduled sync
-- does not need it.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'sync_retailpilot_stock' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'sync_retailpilot_stock');
