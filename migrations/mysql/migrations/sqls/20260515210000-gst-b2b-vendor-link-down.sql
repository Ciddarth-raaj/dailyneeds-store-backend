ALTER TABLE vendor_filing_date
  MODIFY COLUMN last_filing_date DATE NOT NULL COMMENT 'Max fldtr1 across invoices for this vendor in this sync';

ALTER TABLE gst_b2b_invoices
  MODIFY COLUMN fldtr1 VARCHAR(32) NULL COMMENT 'Filing / return date string from GSTN (used for vendor last filing)';

ALTER TABLE gst_b2b
  DROP FOREIGN KEY fk_gst_b2b_vendor,
  DROP INDEX idx_gst_b2b_vendor,
  DROP COLUMN gst_vendor_id;
