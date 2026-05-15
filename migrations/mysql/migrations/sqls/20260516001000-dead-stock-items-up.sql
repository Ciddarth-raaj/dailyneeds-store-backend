CREATE TABLE `dead_stock_items` (
  `id` BIGINT(20) NOT NULL AUTO_INCREMENT,
  `product_id` INT(11) NOT NULL,
  `stock` DECIMAL(14, 4) NOT NULL DEFAULT 0,
  `stock_value` DECIMAL(16, 2) NOT NULL DEFAULT 0,
  `outlet_id` INT(11) NOT NULL,
  `type` ENUM(
    'thirty-days',
    'ninety-days',
    'one-twenty-days',
    'more-than-one-twenty-days'
  ) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dead_stock_items_product_outlet_type` (`product_id`, `outlet_id`, `type`),
  CONSTRAINT `fk_dead_stock_items_outlet` FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_dead_stock_items_product` FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
