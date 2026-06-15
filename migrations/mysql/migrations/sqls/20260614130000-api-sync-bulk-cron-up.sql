-- Server crontab schedules for bulk import scripts
UPDATE api_sync_cron_config SET cron_expression = '30 2 * * *' WHERE log_type = 'debit_note_bulk';
UPDATE api_sync_cron_config SET cron_expression = '35 2 * * *' WHERE log_type = 'purchase_bulk';
UPDATE api_sync_cron_config SET cron_expression = '30 23 * * *' WHERE log_type = 'product_sales_bulk';
UPDATE api_sync_cron_config SET cron_expression = '0 6 * * *' WHERE log_type = 'dead_stock_items_bulk';
UPDATE api_sync_cron_config SET cron_expression = '0 7 * * *' WHERE log_type = 'product_distributors_hq_import';
UPDATE api_sync_cron_config SET cron_expression = '30 6 * * *' WHERE log_type = 'item_markupdown_bulk';
