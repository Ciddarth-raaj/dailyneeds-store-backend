ALTER TABLE gst_purchase_match
  DROP FOREIGN KEY fk_gst_purchase_match_b2b_invoice,
  DROP INDEX uq_gst_purchase_match_b2b_invoice,
  DROP INDEX idx_gst_purchase_match_b2b_invoice,
  DROP COLUMN gst_b2b_invoice_id;
