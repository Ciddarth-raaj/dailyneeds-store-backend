-- RetailPilot debit notes: the sync pre-fills the Debit Note screen's
-- internal fields (round-off, total amount, the purchase's MRC ref no) in
-- debit_note_internal, as the purchase sync does for purchase_internal.
-- filled_by_sync = 1 marks a row the sync wrote; saving the debit note on
-- the screen sets it to 0, and from then on the sync leaves the debit note
-- to Accounts. Existing rows were all saved by Accounts: 0.
-- Added only where missing (safe to run again).
SET @have = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'debit_note_internal' AND column_name = 'filled_by_sync'
);
SET @sql = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `debit_note_internal` ADD COLUMN `filled_by_sync` TINYINT(1) NOT NULL DEFAULT 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
