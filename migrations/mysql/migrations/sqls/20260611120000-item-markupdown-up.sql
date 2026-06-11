CREATE TABLE `item_markupdown` (
  `item_code` INT(11) NOT NULL,
  `mpfd_class_type` VARCHAR(32) NULL DEFAULT NULL,
  `mpfd_id` VARCHAR(64) NULL DEFAULT NULL,
  `mpfd_markup_down` VARCHAR(128) NULL DEFAULT NULL,
  `mpfd_price_parameter` VARCHAR(64) NULL DEFAULT NULL,
  `mpfd_value` VARCHAR(32) NULL DEFAULT NULL,
  `mpfd_amt_perc` VARCHAR(64) NULL DEFAULT NULL,
  `mpfd_roundoff_type` VARCHAR(64) NULL DEFAULT NULL,
  `mpfd_roundoff_value` VARCHAR(32) NULL DEFAULT NULL,
  `mpfd_status` VARCHAR(32) NULL DEFAULT NULL,
  `mpfd_mrp_price_param` VARCHAR(64) NULL DEFAULT NULL,
  `mpfd_mrp_value` VARCHAR(32) NULL DEFAULT NULL,
  `mpfd_mrp_amt_perc` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`item_code`),
  CONSTRAINT `fk_item_markupdown_product` FOREIGN KEY (`item_code`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
