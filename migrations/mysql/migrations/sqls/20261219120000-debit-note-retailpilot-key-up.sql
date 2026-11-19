-- RetailPilot debit notes (POST /debit-note/retailpilot-sync).
-- mprh_pr_refno is the debit note's number - the Tally voucher number - and
-- RetailPilot numbers debit notes per store and financial year
-- (Warehouse 1407..., Moolakulam 50..., Kathirkamam 51...), so the same
-- number appears at two outlets. The table-wide UNIQUE on mprh_pr_refno
-- would refuse the second one. Tally's responses are already matched on
-- voucher number + outlet (debit_note_tally_response: VoucherNo, CostCentre).
--
-- The new key holds every row the old one did (it adds columns to it), so
-- this cannot fail on existing data, and the GoFrugal bulk import's
-- ON DUPLICATE KEY still finds its own rows (same outlet, number, refno).
-- The sync finds a debit note by outlet + mprh_pr_no (the REC-... slug),
-- which the key's leading columns index.
ALTER TABLE `debit_note`
  DROP INDEX `mprh_pr_refno`,
  ADD UNIQUE KEY `uniq_debit_note_store_pr` (`store_id`, `mprh_pr_no`, `mprh_pr_refno`);
