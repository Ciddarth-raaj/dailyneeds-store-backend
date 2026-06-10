CREATE TABLE `price_checker_items` (
  `id` BIGINT(20) NOT NULL AUTO_INCREMENT,
  `outlet_id` INT(11) NOT NULL,
  `outlet_name` VARCHAR(255) NULL,
  `product_id` INT(11) NOT NULL,
  `item_name` VARCHAR(500) NULL,
  `batch_no` VARCHAR(100) NULL,
  `purchase_price` DECIMAL(16, 4) NULL,
  `landing_cost` DECIMAL(16, 4) NULL,
  `old_mrp` DECIMAL(16, 4) NULL,
  `new_mrp` DECIMAL(16, 4) NULL,
  `old_selling_price` DECIMAL(16, 4) NULL,
  `new_selling_price` DECIMAL(16, 4) NULL,
  `de_name` VARCHAR(500) NULL,
  `de_display_name` VARCHAR(500) NULL,
  `de_distributor` VARCHAR(255) NULL,
  `de_preparation_type` VARCHAR(100) NULL,
  `distributor_id` INT(11) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_price_checker_items_product` (`product_id`),
  KEY `idx_price_checker_items_outlet` (`outlet_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `price_checker_meta` (
  `id` TINYINT NOT NULL DEFAULT 1,
  `uploaded_at` DATETIME NOT NULL,
  `uploaded_by` INT(11) NULL,
  `total_rows` INT(11) NOT NULL DEFAULT 0,
  `issue_product_count` INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
