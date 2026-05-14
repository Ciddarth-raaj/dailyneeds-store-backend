-- GSTR-2A B2B persisted data (per return period year/month). Re-sync deletes rows for that period first.

CREATE TABLE IF NOT EXISTS gst_b2b (
  gst_b2b_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  year SMALLINT UNSIGNED NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  b2b_index SMALLINT UNSIGNED NOT NULL COMMENT 'Index in Sandbox data.data.b2b[]',
  ctin CHAR(15) NOT NULL,
  cfs VARCHAR(8) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (gst_b2b_id),
  UNIQUE KEY uq_gst_b2b_period_index (year, month, b2b_index),
  KEY idx_gst_b2b_ctin (ctin),
  KEY idx_gst_b2b_period (year, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gst_b2b_invoices (
  gst_b2b_invoice_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  gst_b2b_id INT UNSIGNED NOT NULL,
  inv_index SMALLINT UNSIGNED NOT NULL COMMENT 'Index in inv[] under this B2B block',
  inum VARCHAR(64) NULL,
  idt VARCHAR(32) NULL,
  oinum VARCHAR(64) NULL,
  oidt VARCHAR(32) NULL,
  val DECIMAL(18, 2) NULL,
  pos VARCHAR(8) NULL,
  rchrg VARCHAR(8) NULL,
  inv_typ VARCHAR(16) NULL,
  etin VARCHAR(16) NULL,
  fldtr1 VARCHAR(32) NULL COMMENT 'Filing / return date string from GSTN (used for vendor last filing)',
  diff_percent VARCHAR(16) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (gst_b2b_invoice_id),
  UNIQUE KEY uq_gst_b2b_invoice (gst_b2b_id, inv_index),
  CONSTRAINT fk_gst_b2b_invoice_b2b FOREIGN KEY (gst_b2b_id) REFERENCES gst_b2b (gst_b2b_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gst_b2b_invoice_items (
  gst_b2b_invoice_item_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  gst_b2b_invoice_id INT UNSIGNED NOT NULL,
  line_index SMALLINT UNSIGNED NOT NULL COMMENT '0-based index in itms[]; itms[].num is not stored',
  rt DECIMAL(10, 3) NULL,
  txval DECIMAL(18, 2) NULL,
  iamt DECIMAL(18, 2) NULL,
  camt DECIMAL(18, 2) NULL,
  samt DECIMAL(18, 2) NULL,
  csamt DECIMAL(18, 2) NULL,
  cesrt DECIMAL(10, 3) NULL,
  cesamt DECIMAL(18, 2) NULL,
  adamt DECIMAL(18, 2) NULL,
  itm_det_extra JSON NULL COMMENT 'Other keys from itm_det object not mapped to columns',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (gst_b2b_invoice_item_id),
  UNIQUE KEY uq_gst_b2b_invoice_item_line (gst_b2b_invoice_id, line_index),
  CONSTRAINT fk_gst_b2b_item_invoice FOREIGN KEY (gst_b2b_invoice_id) REFERENCES gst_b2b_invoices (gst_b2b_invoice_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vendor_filing_date (
  vendor_filing_date_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  gst_vendor_id INT UNSIGNED NOT NULL,
  last_filing_date DATE NOT NULL COMMENT 'Max fldtr1 across invoices for this vendor in this sync',
  year SMALLINT UNSIGNED NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_filing_date_id),
  UNIQUE KEY uq_vendor_filing_period (gst_vendor_id, year, month),
  KEY idx_vendor_filing_period (year, month),
  CONSTRAINT fk_vendor_filing_vendor FOREIGN KEY (gst_vendor_id) REFERENCES gst_vendors (gst_vendor_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
