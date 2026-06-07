ALTER TABLE `product_distributor_master`
  DROP PRIMARY KEY,
  DROP INDEX `uk_product_distributor_master_mdm_dist_code`,
  MODIFY `cid` VARCHAR(64) NULL DEFAULT NULL,
  ADD PRIMARY KEY (`mdm_dist_code`);
