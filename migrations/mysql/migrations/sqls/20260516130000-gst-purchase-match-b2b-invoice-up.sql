-- Step 1: add column nullable (avoids implicit 0 on existing rows)
ALTER TABLE gst_purchase_match
  ADD COLUMN gst_b2b_invoice_id INT UNSIGNED NULL AFTER gst_purchase_match_id;

-- Step 2: legacy rows cannot be linked without a B2B invoice id — remove before FK
DELETE FROM gst_purchase_match WHERE gst_b2b_invoice_id IS NULL;

-- Step 3: required + unique + FK
ALTER TABLE gst_purchase_match
  MODIFY COLUMN gst_b2b_invoice_id INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_gst_purchase_match_b2b_invoice (gst_b2b_invoice_id),
  ADD KEY idx_gst_purchase_match_b2b_invoice (gst_b2b_invoice_id),
  ADD CONSTRAINT fk_gst_purchase_match_b2b_invoice
    FOREIGN KEY (gst_b2b_invoice_id)
    REFERENCES gst_b2b_invoices (gst_b2b_invoice_id)
    ON DELETE RESTRICT;
