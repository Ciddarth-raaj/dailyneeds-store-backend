-- Restore NOT NULL: backfill NULL names before tightening column.
UPDATE gst_vendors
SET vendor_name = CONCAT('Supplier ', gstin)
WHERE vendor_name IS NULL OR TRIM(COALESCE(vendor_name, '')) = '';

ALTER TABLE gst_vendors
  MODIFY COLUMN vendor_name VARCHAR(512) NOT NULL;
