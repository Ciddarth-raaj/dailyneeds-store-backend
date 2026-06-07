INSERT INTO `all_permissions` (`permission_key`) VALUES
  ('view_stock_holding_report'),
  ('add_stock_holding_report'),
  ('delete_stock_holding_report');

CREATE TABLE `stock_holding_report` (
  `stock_holding_report_id` INT NOT NULL AUTO_INCREMENT,
  `report_name` VARCHAR(255) NOT NULL,
  `date` DATE NOT NULL,
  `created_by` INT NULL COMMENT 'employee_id from new_employee',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stock_holding_report_id`),
  KEY `idx_stock_holding_report_date` (`date`),
  KEY `idx_stock_holding_report_created_by` (`created_by`),
  CONSTRAINT `fk_stock_holding_report_created_by`
    FOREIGN KEY (`created_by`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `stock_holding_items` (
  `stock_holding_item_id` INT NOT NULL AUTO_INCREMENT,
  `stock_holding_report_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `outlet_id` INT NOT NULL,
  `current_stock` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `current_stock_value` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `stock_duration` INT NULL,
  `status` VARCHAR(100) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stock_holding_item_id`),
  UNIQUE KEY `uq_stock_holding_report_product_outlet` (`stock_holding_report_id`, `product_id`, `outlet_id`),
  KEY `idx_stock_holding_items_report_id` (`stock_holding_report_id`),
  KEY `idx_stock_holding_items_product_id` (`product_id`),
  KEY `idx_stock_holding_items_outlet_id` (`outlet_id`),
  CONSTRAINT `fk_stock_holding_items_report`
    FOREIGN KEY (`stock_holding_report_id`) REFERENCES `stock_holding_report` (`stock_holding_report_id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_stock_holding_items_product`
    FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`),
  CONSTRAINT `fk_stock_holding_items_outlet`
    FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
