ALTER TABLE `product_table`
  ADD `distributor_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL AFTER `buyer_name`,
  ADD `de_manufacturer_name` VARCHAR(255) NULL DEFAULT NULL AFTER `distributor_id`,
  ADD CONSTRAINT `fk_product_table_distributor_id`
    FOREIGN KEY (`distributor_id`) REFERENCES `product_distributor_master` (`cid`)
    ON DELETE SET NULL ON UPDATE CASCADE;
