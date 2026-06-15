UPDATE api_sync_cron_config SET cron_expression = '' WHERE log_type IN (
  'debit_note_bulk',
  'purchase_bulk',
  'product_sales_bulk',
  'dead_stock_items_bulk',
  'product_distributors_hq_import',
  'item_markupdown_bulk'
);
