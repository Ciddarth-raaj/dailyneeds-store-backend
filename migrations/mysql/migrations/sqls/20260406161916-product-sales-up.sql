ALTER TABLE `product_offers`
  ADD COLUMN `stock_output` DECIMAL(14, 4) NOT NULL DEFAULT 0 COMMENT 'Cumulative sales qty from product_sales' AFTER `stock_input`;

CREATE TABLE `product_sales` (
  `product_sale_id` BIGINT(20) NOT NULL AUTO_INCREMENT,
  `retail_outlet_id` INT(11) NOT NULL,
  `product_id` INT(11) NOT NULL,
  `tran_date` DATE NOT NULL,
  `tran_qty` DECIMAL(14, 4) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`product_sale_id`),
  KEY `idx_product_sales_product_id` (`product_id`),
  KEY `idx_product_sales_outlet_date` (`retail_outlet_id`, `tran_date`),
  CONSTRAINT `fk_product_sales_outlet` FOREIGN KEY (`retail_outlet_id`) REFERENCES `outlets` (`outlet_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_product_sales_product` FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
