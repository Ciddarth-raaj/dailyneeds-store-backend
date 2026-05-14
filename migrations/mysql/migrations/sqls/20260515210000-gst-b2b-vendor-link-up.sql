-- Link B2B blocks to gst_vendors; widen fldtr1; allow filing date unknown until GSTN returns fldtr1

ALTER TABLE gst_b2b
  ADD COLUMN gst_vendor_id INT UNSIGNED NULL AFTER b2b_index,
  ADD KEY idx_gst_b2b_vendor (gst_vendor_id),
  ADD CONSTRAINT fk_gst_b2b_vendor FOREIGN KEY (gst_vendor_id) REFERENCES gst_vendors (gst_vendor_id) ON DELETE SET NULL;

ALTER TABLE gst_b2b_invoices
  MODIFY COLUMN fldtr1 VARCHAR(64) NULL COMMENT 'Filing / return date string from GSTN';

ALTER TABLE vendor_filing_date
  MODIFY COLUMN last_filing_date DATE NULL COMMENT 'Max fldtr1 (or fallback idt) for vendor in this sync';
