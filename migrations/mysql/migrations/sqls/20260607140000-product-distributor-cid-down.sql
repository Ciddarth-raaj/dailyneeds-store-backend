USE `dailyneeds-store`;

ALTER TABLE `product_distributor`
  DROP INDEX `idx_product_distributor_cid`,
  DROP COLUMN `cid`;
