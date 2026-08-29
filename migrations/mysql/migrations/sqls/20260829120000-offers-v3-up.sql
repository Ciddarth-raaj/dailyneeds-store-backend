INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_offers_v3');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_offers_v3');

CREATE TABLE `offers_v3` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `item_code` VARCHAR(64) NOT NULL,
  `item_name` VARCHAR(255) NOT NULL,
  `offer_type` ENUM('percentage', 'flat', 'fixed_price') NOT NULL,
  `value` DECIMAL(12,2) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_v3_item_code` (`item_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
