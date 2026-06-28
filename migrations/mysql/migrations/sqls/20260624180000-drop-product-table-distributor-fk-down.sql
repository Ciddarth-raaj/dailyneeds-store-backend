ALTER TABLE `product_table`
  ADD CONSTRAINT `fk_product_table_distributor_id`
    FOREIGN KEY (`distributor_id`) REFERENCES `product_distributor_master` (`cid`)
    ON DELETE SET NULL ON UPDATE CASCADE;
