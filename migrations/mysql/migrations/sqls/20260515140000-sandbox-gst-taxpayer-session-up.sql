CREATE TABLE IF NOT EXISTS sandbox_gst_taxpayer_session (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1 COMMENT 'Singleton row',
  taxpayer_access_token TEXT NULL COMMENT 'GST portal taxpayer session JWT (not the Sandbox API JWT)',
  token_expires_at_ms BIGINT UNSIGNED NULL COMMENT 'Epoch ms when taxpayer token expires',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sandbox_gst_taxpayer_session (id, taxpayer_access_token, token_expires_at_ms)
VALUES (1, NULL, NULL);
