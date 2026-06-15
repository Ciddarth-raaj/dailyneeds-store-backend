CREATE TABLE IF NOT EXISTS api_sync_log (
  log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  log_type VARCHAR(64) NOT NULL,
  method VARCHAR(10) NOT NULL DEFAULT 'POST',
  path VARCHAR(255) NOT NULL,
  status ENUM('success', 'failed') NOT NULL,
  status_code INT NULL,
  duration_ms INT UNSIGNED NULL,
  row_count INT UNSIGNED NULL,
  source ENUM('manual', 'cron', 'external') NOT NULL DEFAULT 'manual',
  employee_id INT UNSIGNED NULL,
  metadata_json JSON NULL,
  error_message VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_api_sync_log_type_created (log_type, created_at),
  KEY idx_api_sync_log_created (created_at)
);

CREATE TABLE IF NOT EXISTS api_sync_cron_config (
  config_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  log_type VARCHAR(64) NOT NULL,
  label VARCHAR(128) NOT NULL,
  category ENUM('sync', 'bulk') NOT NULL DEFAULT 'sync',
  cron_expression VARCHAR(64) NOT NULL DEFAULT '',
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (config_id),
  UNIQUE KEY uq_api_sync_cron_config_log_type (log_type)
);

INSERT INTO api_sync_cron_config (log_type, label, category, cron_expression, is_enabled) VALUES
  ('product_sync', 'Product Sync', 'sync', '0 6 * * *', 1),
  ('employee_sync', 'Employee Sync', 'sync', '0 7 * * *', 1),
  ('stock_holding_report_sync', 'Stock Holding Report Sync', 'sync', '30 7 * * *', 1),
  ('purchase_bulk', 'Purchase Bulk Import', 'bulk', '35 2 * * *', 1),
  ('product_sales_bulk', 'Product Sales Bulk', 'bulk', '30 23 * * *', 1),
  ('debit_note_bulk', 'Debit Note Bulk Import', 'bulk', '30 2 * * *', 1),
  ('dead_stock_items_bulk', 'Dead Stock Bulk Import', 'bulk', '0 6 * * *', 1),
  ('product_distributors_hq_import', 'HQ Distributor Import', 'bulk', '0 7 * * *', 1),
  ('item_markupdown_bulk', 'Item Markup/Down Bulk Import', 'bulk', '30 6 * * *', 1)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  category = VALUES(category),
  cron_expression = VALUES(cron_expression);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_api_logs');
