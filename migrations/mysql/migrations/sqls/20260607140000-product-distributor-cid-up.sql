USE `dnds_prod`;

ALTER TABLE `product_distributor`
  ADD COLUMN `cid` VARCHAR(64) NULL COMMENT 'FK to product_distributor_master' AFTER `mdm_dist_code`,
  ADD INDEX `idx_product_distributor_cid` (`cid`);
