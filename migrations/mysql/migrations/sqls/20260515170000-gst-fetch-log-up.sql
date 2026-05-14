CREATE TABLE IF NOT EXISTS gst_fetch_log (
  fetch_log_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type VARCHAR(64) NOT NULL,
  year SMALLINT UNSIGNED NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  created_by INT UNSIGNED NULL COMMENT 'App user id from JWT (req.decoded.id)',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fetch_log_id),
  KEY idx_gst_fetch_log_type_period (type, year, month),
  KEY idx_gst_fetch_log_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
