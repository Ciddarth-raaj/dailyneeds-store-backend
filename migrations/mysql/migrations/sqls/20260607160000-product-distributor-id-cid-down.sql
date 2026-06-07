ALTER TABLE `product_table`
  DROP FOREIGN KEY `fk_product_table_distributor_id`;

ALTER TABLE `product_table`
  MODIFY `distributor_id` INT NULL DEFAULT NULL;

ALTER TABLE `product_table`
  ADD CONSTRAINT `fk_product_table_distributor_id`
    FOREIGN KEY (`distributor_id`) REFERENCES `product_distributor_master` (`mdm_dist_code`)
    ON DELETE SET NULL ON UPDATE CASCADE;
