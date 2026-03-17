INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_product_offers');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_product_offers');

CREATE TABLE `product_offers` (
  `product_id` INT(11) NOT NULL,
  `mrp` DECIMAL(12,2) NULL DEFAULT NULL,
  `selling_price` DECIMAL(12,2) NULL DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`product_id`),
  CONSTRAINT `fk_product_offers_product` FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;