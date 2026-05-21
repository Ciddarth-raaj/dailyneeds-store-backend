-- Run scripts/cleanup-purchase-tally-duplicate-master-ids.js before this migration if duplicate MasterIDs exist.

ALTER TABLE purchase_tally_response
  ADD COLUMN purchase_id BIGINT NULL AFTER MasterID;

UPDATE purchase_tally_response tr
INNER JOIN outlets o ON TRIM(tr.CostCentre) = TRIM(o.outlet_name)
INNER JOIN purchase p
  ON TRIM(p.mmh_mrc_refno) = TRIM(tr.VoucherNo)
 AND p.retail_outlet_id = o.outlet_id
 AND UPPER(TRIM(p.supplier_gstn)) = UPPER(TRIM(tr.GSTIN))
 AND LOWER(TRIM(p.supplier_name)) = LOWER(TRIM(tr.SupplierName))
SET tr.purchase_id = p.purchase_id;

-- One row per purchase: keep the latest tally response per purchase_id.
DELETE t1 FROM purchase_tally_response t1
INNER JOIN purchase_tally_response t2
  ON t1.purchase_id = t2.purchase_id
  AND t1.purchase_id IS NOT NULL
  AND (
    t1.created_at < t2.created_at
    OR (
      t1.created_at = t2.created_at
      AND COALESCE(t1.updated_at, t1.created_at) < COALESCE(t2.updated_at, t2.created_at)
    )
    OR (
      t1.created_at = t2.created_at
      AND COALESCE(t1.updated_at, t1.created_at) = COALESCE(t2.updated_at, t2.created_at)
      AND t1.MasterID > t2.MasterID
    )
  );

DELETE FROM purchase_tally_response WHERE purchase_id IS NULL;

-- Drop (VoucherNo, CostCentre) unique index if present; index name varies by environment.
SET @voucher_idx_name = (
  SELECT index_name
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'purchase_tally_response'
    AND index_name != 'PRIMARY'
    AND non_unique = 0
    AND column_name = 'VoucherNo'
    AND seq_in_index = 1
  LIMIT 1
);

SET @drop_voucher_idx_sql = IF(
  @voucher_idx_name IS NOT NULL,
  CONCAT(
    'ALTER TABLE purchase_tally_response DROP INDEX `',
    @voucher_idx_name,
    '`'
  ),
  'SELECT 1'
);

PREPARE drop_voucher_idx_stmt FROM @drop_voucher_idx_sql;
EXECUTE drop_voucher_idx_stmt;
DEALLOCATE PREPARE drop_voucher_idx_stmt;

ALTER TABLE purchase_tally_response
  MODIFY purchase_id BIGINT NOT NULL,
  ADD PRIMARY KEY (purchase_id),
  ADD UNIQUE KEY uq_purchase_tally_response_master_id (MasterID),
  ADD CONSTRAINT fk_purchase_tally_response_purchase
    FOREIGN KEY (purchase_id) REFERENCES purchase (purchase_id)
    ON DELETE CASCADE ON UPDATE CASCADE;
