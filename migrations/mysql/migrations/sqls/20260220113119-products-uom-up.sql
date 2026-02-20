-- Add purchase_uom and store_uom columns to product_table
ALTER TABLE product_table
  ADD COLUMN purchase_uom INT NULL,
  ADD COLUMN store_uom INT NULL;
