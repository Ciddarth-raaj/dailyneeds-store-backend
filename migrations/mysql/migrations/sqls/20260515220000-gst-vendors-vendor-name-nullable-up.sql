-- Allow unknown trade names until Sandbox search succeeds; clear legacy "Supplier <GSTIN>" placeholders.
ALTER TABLE gst_vendors
  MODIFY COLUMN vendor_name VARCHAR(512) NULL COMMENT 'Trade/legal name from Sandbox search; NULL if unknown';

UPDATE gst_vendors
SET vendor_name = NULL
WHERE vendor_name IS NOT NULL
  AND (
    TRIM(vendor_name) = ''
    OR vendor_name REGEXP '^[Ss]upplier[[:space:]]+[0-9A-Z]{15}$'
  );
