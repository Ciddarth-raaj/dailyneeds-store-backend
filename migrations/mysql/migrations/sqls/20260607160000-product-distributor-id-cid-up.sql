ALTER TABLE `product_table`
  DROP FOREIGN KEY `fk_product_table_distributor_id`;

ALTER TABLE `product_table`
  MODIFY `distributor_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL;

ALTER TABLE `product_table`
  ADD CONSTRAINT `fk_product_table_distributor_id`
    FOREIGN KEY (`distributor_id`) REFERENCES `product_distributor_master` (`cid`)
    ON DELETE SET NULL ON UPDATE CASCADE;
