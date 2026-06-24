INSERT INTO api_sync_cron_config (log_type, label, category, cron_expression, is_enabled) VALUES
  ('hq_offers_hdr_bulk', 'HQ Offers Header Bulk', 'bulk', '0 8 * * *', 1),
  ('hq_offers_products_bulk', 'HQ Offers Products Bulk', 'bulk', '0 8 * * *', 1),
  ('hq_offers_issue_bulk', 'HQ Offers Issue Bulk', 'bulk', '0 8 * * *', 1)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  category = VALUES(category),
  cron_expression = VALUES(cron_expression);
