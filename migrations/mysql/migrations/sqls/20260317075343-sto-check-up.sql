
CREATE TABLE `sto_check` (
  `dn_ref_no` INT(11) NOT NULL,
  `product_id` INT(11) NOT NULL,
  `file_qty` INT(11) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`dn_ref_no`, `product_id`),
  CONSTRAINT `fk_sto_check_product` FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_sto');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_sto');