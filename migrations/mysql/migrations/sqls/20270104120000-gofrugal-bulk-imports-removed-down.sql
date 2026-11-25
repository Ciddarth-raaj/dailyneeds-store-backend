-- Reverse of 20270104120000-gofrugal-bulk-imports-removed: the schedule rows
-- come back DISABLED - the routes they would watch no longer exist, so
-- bringing those back is a code change, not a migration. Re-runnable.
INSERT INTO `api_sync_cron_config` (`log_type`, `label`, `category`, `cron_expression`, `is_enabled`)
SELECT t.log_type, t.label, 'bulk', t.cron_expression, 0
FROM (
  SELECT 'purchase_bulk' AS log_type, 'Purchase Bulk Import' AS label, '35 2 * * *' AS cron_expression
  UNION ALL SELECT 'product_sales_bulk', 'Product Sales Bulk', '30 23 * * *'
  UNION ALL SELECT 'debit_note_bulk', 'Debit Note Bulk Import', '30 2 * * *'
  UNION ALL SELECT 'dead_stock_items_bulk', 'Dead Stock Bulk Import', '0 6 * * *'
  UNION ALL SELECT 'product_distributors_hq_import', 'HQ Distributor Import', '0 7 * * *'
  UNION ALL SELECT 'item_markupdown_bulk', 'Item Markup/Down Bulk Import', '30 6 * * *'
  UNION ALL SELECT 'hq_offers_hdr_bulk', 'HQ Offers Header Bulk', '0 8 * * *'
  UNION ALL SELECT 'hq_offers_products_bulk', 'HQ Offers Products Bulk', '0 8 * * *'
  UNION ALL SELECT 'hq_offers_issue_bulk', 'HQ Offers Issue Bulk', '0 8 * * *'
) t
WHERE NOT EXISTS (SELECT 1 FROM `api_sync_cron_config` c WHERE c.log_type = t.log_type);
