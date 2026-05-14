-- gst_vendors: vendor list + GSTIN search cache.
-- Includes gstin (unique lookup) and sandbox_search_response (cached Sandbox JSON) in addition to vendor_name / is_active / timestamps.
CREATE TABLE IF NOT EXISTS gst_vendors (
  gst_vendor_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  gstin CHAR(15) NOT NULL COMMENT 'Uppercase GSTIN; unique lookup for search cache',
  vendor_name VARCHAR(512) NOT NULL,
  sandbox_search_response JSON NULL COMMENT 'Cached Sandbox POST /gst/compliance/public/gstin/search response body',
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=active, 0=inactive',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (gst_vendor_id),
  UNIQUE KEY uq_gst_vendors_gstin (gstin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
