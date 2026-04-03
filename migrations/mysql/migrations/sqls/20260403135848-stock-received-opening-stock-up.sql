ALTER TABLE `product_offers`
  ADD COLUMN `opening_stock` DECIMAL(14, 4) NOT NULL DEFAULT 0 COMMENT 'Opening stock qty for offer' AFTER `selling_price`;

ALTER TABLE `product_offers`
  ADD COLUMN `stock_input` DECIMAL(14, 4) NOT NULL DEFAULT 0 COMMENT 'Cumulative recd_qty from stock_received where is_offer=1' AFTER `opening_stock`;