-- 1. Create child table for invoice lines
CREATE TABLE IF NOT EXISTS purchase_acknowledgement_invoice (
  purchase_acknowledgement_invoice_id INT AUTO_INCREMENT PRIMARY KEY,
  purchase_acknowledgement_id INT NOT NULL,
  invoice_no VARCHAR(100) NULL COMMENT 'Vendor invoice number',
  invoice_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pai_purchase_acknowledgement
    FOREIGN KEY (purchase_acknowledgement_id) REFERENCES purchase_acknowledgement(purchase_acknowledgement_id) ON DELETE CASCADE
);

-- 2. Migrate existing single invoice_date/amount into the new table
INSERT INTO purchase_acknowledgement_invoice (purchase_acknowledgement_id, invoice_no, invoice_date, amount)
SELECT purchase_acknowledgement_id, NULL, invoice_date, amount
FROM purchase_acknowledgement;

-- 3. Drop columns from parent table
ALTER TABLE purchase_acknowledgement
  DROP COLUMN invoice_date,
  DROP COLUMN amount;

ALTER TABLE purchase_return_extra
  ADD COLUMN purchase_acknowledgement_id INT NULL COMMENT 'FK to purchase_acknowledgement' AFTER created_by,
  ADD CONSTRAINT fk_purchase_return_extra_purchase_acknowledgement
    FOREIGN KEY (purchase_acknowledgement_id) REFERENCES purchase_acknowledgement(purchase_acknowledgement_id) ON DELETE SET NULL;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('update_purchase_return_status');