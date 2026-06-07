ALTER TABLE `product_table`
  DROP FOREIGN KEY `fk_product_table_distributor_id`,
  DROP COLUMN `de_manufacturer_name`,
  DROP COLUMN `distributor_id`;
