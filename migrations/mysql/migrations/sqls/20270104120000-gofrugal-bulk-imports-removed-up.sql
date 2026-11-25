-- The old GoFrugal bulk feeds are removed: their routes are gone, so their
-- schedule rows are deleted and they leave the API Logs "Bulk Imports" tab.
--
-- THE HISTORY STAYS. api_sync_log rows of these types are not touched, and
-- constants/api_sync_types.js keeps the entries (retired: true) so those
-- rows keep their labels.
SET @had_rows = (SELECT COUNT(*) FROM `api_sync_cron_config` WHERE `log_type` IN (
  'purchase_bulk', 'product_sales_bulk', 'debit_note_bulk', 'dead_stock_items_bulk',
  'product_distributors_hq_import', 'item_markupdown_bulk',
  'hq_offers_hdr_bulk', 'hq_offers_products_bulk', 'hq_offers_issue_bulk'));

DELETE FROM `api_sync_cron_config` WHERE `log_type` IN (
  'purchase_bulk', 'product_sales_bulk', 'debit_note_bulk', 'dead_stock_items_bulk',
  'product_distributors_hq_import', 'item_markupdown_bulk',
  'hq_offers_hdr_bulk', 'hq_offers_products_bulk', 'hq_offers_issue_bulk');

-- REPORT ONLY.
SELECT @had_rows AS GOFRUGAL_BULK_SCHEDULE_ROWS_REMOVED;
