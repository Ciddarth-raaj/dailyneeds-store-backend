DELETE FROM `offers_v3_low_stock_warnings`;

ALTER TABLE `offers_v3_low_stock_warnings`
  DROP INDEX `uq_offers_v3_low_stock_item`,
  CHANGE COLUMN `total_stock_qty` `stock_qty` DECIMAL(14,3) NOT NULL,
  ADD COLUMN `outlet_id` INT(11) NOT NULL DEFAULT 0 AFTER `item_code`,
  ADD COLUMN `batch_no` VARCHAR(100) NOT NULL DEFAULT '' AFTER `outlet_id`,
  ADD UNIQUE KEY `uq_offers_v3_low_stock_key` (`item_code`, `outlet_id`, `batch_no`);
