INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_offers_v3');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_offers_v3');

-- Item-level offers: apply to the item everywhere (all outlets, all current/future
-- stock) until manually made inactive.
CREATE TABLE `offers_v3_item` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `item_code` INT(11) NOT NULL,
  `offer_type` ENUM('percentage', 'flat', 'fixed_price') NOT NULL,
  `value` DECIMAL(12,2) NOT NULL,
  `status` ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  `created_by` INT(11) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_offers_v3_item_item_code` (`item_code`),
  KEY `idx_offers_v3_item_status` (`status`),
  CONSTRAINT `fk_offers_v3_item_product` FOREIGN KEY (`item_code`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Batch-specific offers: apply to one named batch of one item at one outlet only.
-- An item can carry several independent active batch offers at once.
CREATE TABLE `offers_v3_batch` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `item_code` INT(11) NOT NULL,
  `outlet_id` INT(11) NOT NULL,
  `batch_no` VARCHAR(100) NOT NULL,
  `offer_type` ENUM('percentage', 'flat', 'fixed_price') NOT NULL,
  `value` DECIMAL(12,2) NOT NULL,
  `status` ENUM('active', 'zero_stock_flagged', 'batch_zero_ended', 'inactive') NOT NULL DEFAULT 'active',
  `created_by` INT(11) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_offers_v3_batch_lookup` (`item_code`, `outlet_id`, `batch_no`),
  KEY `idx_offers_v3_batch_status` (`status`),
  CONSTRAINT `fk_offers_v3_batch_product` FOREIGN KEY (`item_code`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_offers_v3_batch_outlet` FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Latest known price + stock per item/outlet/batch. Two independent uploads feed
-- this table: a Price Checker-style Excel (Item Code, Outlet, Batch No, MRP,
-- Selling Price) updates only mrp/selling_price/price_uploaded_at, and a stock
-- Excel (Item Code, Outlet, Batch No, Stock Qty) updates only
-- stock_qty/stock_uploaded_at — each upsert inserts a new row when none existed
-- and otherwise leaves the other upload's columns untouched.
-- Not FK'd to product_table/outlets: a row can exist before/without a matching
-- offer, and rows are just overwritten per key on the next upload.
CREATE TABLE `offers_v3_batch_data` (
  `item_code` INT(11) NOT NULL,
  `outlet_id` INT(11) NOT NULL,
  `batch_no` VARCHAR(100) NOT NULL,
  `mrp` DECIMAL(12,2) NULL DEFAULT NULL,
  `selling_price` DECIMAL(12,2) NULL DEFAULT NULL,
  `price_uploaded_at` DATETIME NULL DEFAULT NULL,
  `stock_qty` DECIMAL(14,3) NULL DEFAULT NULL,
  `stock_uploaded_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`item_code`, `outlet_id`, `batch_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Batches of an item that already has an active offer (item-level or another
-- batch), seen in a stock upload but not yet tagged with their own offer.
-- Surfaced for admin confirmation rather than assuming inheritance.
CREATE TABLE `offers_v3_untagged_batches` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `item_code` INT(11) NOT NULL,
  `outlet_id` INT(11) NOT NULL,
  `batch_no` VARCHAR(100) NOT NULL,
  `status` ENUM('pending', 'dismissed') NOT NULL DEFAULT 'pending',
  `detected_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_v3_untagged_batch` (`item_code`, `outlet_id`, `batch_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
