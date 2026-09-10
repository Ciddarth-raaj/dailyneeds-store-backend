-- Landing cost is now part of Offers V3's own price upload sheet (optional
-- column) instead of being cross-referenced from the separate Price Checker
-- upload, which isn't guaranteed to be recently uploaded or aligned to the
-- same item/outlet/batch keys.
ALTER TABLE `offers_v3_batch_data` ADD COLUMN `landing_cost` DECIMAL(12,2) NULL DEFAULT NULL AFTER `selling_price`;
