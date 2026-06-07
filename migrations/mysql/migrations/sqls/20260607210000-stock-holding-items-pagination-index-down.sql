DROP INDEX `idx_product_images_product_priority` ON `product_images`;

ALTER TABLE `stock_holding_items`
  DROP INDEX `idx_stock_holding_items_report_item`;
