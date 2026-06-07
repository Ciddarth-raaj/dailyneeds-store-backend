ALTER TABLE `stock_holding_items`
  ADD INDEX `idx_stock_holding_items_report_item` (`stock_holding_report_id`, `stock_holding_item_id`);

CREATE INDEX `idx_product_images_product_priority`
  ON `product_images` (`product_id`, `priority`, `image_id`);
