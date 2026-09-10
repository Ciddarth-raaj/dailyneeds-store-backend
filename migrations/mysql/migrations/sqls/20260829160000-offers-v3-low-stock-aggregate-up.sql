-- Low-stock warnings now apply per item, not per outlet/batch: the check is
-- against the item's total stock summed across every store and batch, since
-- an item-level offer applies everywhere. Existing per-outlet/batch rows are
-- entirely derived data (recomputed on the next stock upload), so they're
-- simply cleared rather than migrated.
DELETE FROM `offers_v3_low_stock_warnings`;

ALTER TABLE `offers_v3_low_stock_warnings`
  DROP INDEX `uq_offers_v3_low_stock_key`,
  DROP COLUMN `outlet_id`,
  DROP COLUMN `batch_no`,
  CHANGE COLUMN `stock_qty` `total_stock_qty` DECIMAL(14,3) NOT NULL,
  ADD UNIQUE KEY `uq_offers_v3_low_stock_item` (`item_code`);
