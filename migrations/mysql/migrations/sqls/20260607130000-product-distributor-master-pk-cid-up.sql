ALTER TABLE `product_distributor_master`
  DROP PRIMARY KEY,
  MODIFY `cid` VARCHAR(64) NOT NULL,
  ADD PRIMARY KEY (`cid`),
  ADD UNIQUE KEY `uk_product_distributor_master_mdm_dist_code` (`mdm_dist_code`);
