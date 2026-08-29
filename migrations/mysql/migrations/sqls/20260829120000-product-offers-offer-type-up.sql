ALTER TABLE `product_offers`
  ADD COLUMN `offer_type` ENUM('save', 'percent_off') NULL DEFAULT NULL AFTER `selling_price`,
  ADD COLUMN `offer_value` DECIMAL(12,2) NULL DEFAULT NULL AFTER `offer_type`;
