-- Tally's responses to debit notes are linked to their debit note when they
-- come in (debit_note_tally_response.debit_note_id), as purchase responses
-- are linked to their purchase (purchase_tally_response.purchase_id). The
-- Debit Note screen shows "Pushed to Tally" from that link; responses with
-- no link keep the old voucher number + outlet match (GoFrugal debit notes).
--
-- Column and index added only where missing. Responses already stored are
-- linked by the MasterID the export sent, when it is plain
-- ("<debit_note_id>-purchase-entry") and that debit note has the response's
-- voucher number and outlet; the migration's .js links encrypted ones.
SET @have = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'debit_note_tally_response' AND column_name = 'debit_note_id'
);
SET @sql = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `debit_note_tally_response` ADD COLUMN `debit_note_id` BIGINT NULL AFTER `MasterID`, ADD INDEX `idx_dntr_debit_note_id` (`debit_note_id`)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE debit_note_tally_response tr
INNER JOIN debit_note dn
  ON dn.debit_note_id = CAST(SUBSTRING_INDEX(TRIM(tr.MasterID), '-', 1) AS UNSIGNED)
 AND TRIM(dn.mprh_pr_refno) = TRIM(tr.VoucherNo)
INNER JOIN outlets o ON o.outlet_id = dn.store_id AND TRIM(o.outlet_name) = TRIM(tr.CostCentre)
SET tr.debit_note_id = dn.debit_note_id
WHERE tr.debit_note_id IS NULL
  AND TRIM(tr.MasterID) REGEXP '^[0-9]+-purchase-entry$';
