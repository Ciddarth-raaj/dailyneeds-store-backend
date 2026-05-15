ALTER TABLE gst_b2b_invoices
  MODIFY COLUMN fldtr1 VARCHAR(32) NULL COMMENT 'Filing / return date string from GSTN (used for vendor last filing)';

ALTER TABLE gst_b2b
  DROP FOREIGN KEY fk_gst_b2b_vendor,
  DROP INDEX idx_gst_b2b_vendor,
  DROP COLUMN gst_vendor_id;
