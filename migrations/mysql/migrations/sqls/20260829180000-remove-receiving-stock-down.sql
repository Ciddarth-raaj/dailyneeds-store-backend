INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_stock_received');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_stock_received');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('delete_stock_received');

CREATE TABLE `stock_received` (
  `stock_received_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `mmd_mrc_no` INT NOT NULL COMMENT 'medishopdb_MED_MRC_DTL.MMD_MRC_NO',
  `mmd_mrc_sl_no` INT NOT NULL COMMENT 'medishopdb_MED_MRC_DTL.MMD_MRC_SL_NO',
  `product_id` INT NOT NULL,
  `recd_qty` DECIMAL(14, 4) NOT NULL COMMENT 'from MMD_RECD_QTY',
  `is_offer` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stock_received_id`),
  UNIQUE KEY `uk_stock_received_mrc_line` (`mmd_mrc_no`, `mmd_mrc_sl_no`),
  CONSTRAINT `fk_stock_received_product` FOREIGN KEY (`product_id`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
