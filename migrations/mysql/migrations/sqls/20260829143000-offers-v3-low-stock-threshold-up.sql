-- Item-level offers: Threshold Qty is required at creation and checked per
-- outlet/batch on every stock upload (margin protection — a costlier batch
-- bought after the offer started shouldn't sell at the old discount
-- unnoticed). Existing rows default to 0 so the column can be added
-- NOT NULL; the API still requires an explicit value on create.
ALTER TABLE `offers_v3_item` ADD COLUMN `threshold_qty` INT(11) NOT NULL DEFAULT 0 AFTER `value`;

-- One row per item/outlet/batch currently at or below its item-level offer's
-- threshold (and above zero). Cleared automatically once stock rises back
-- above the threshold on a later upload, or dismissed by an admin.
CREATE TABLE `offers_v3_low_stock_warnings` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `item_code` INT(11) NOT NULL,
  `outlet_id` INT(11) NOT NULL,
  `batch_no` VARCHAR(100) NOT NULL,
  `stock_qty` DECIMAL(14,3) NOT NULL,
  `threshold_qty` INT(11) NOT NULL,
  `status` ENUM('pending', 'dismissed') NOT NULL DEFAULT 'pending',
  `detected_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_v3_low_stock_key` (`item_code`, `outlet_id`, `batch_no`),
  KEY `idx_offers_v3_low_stock_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
