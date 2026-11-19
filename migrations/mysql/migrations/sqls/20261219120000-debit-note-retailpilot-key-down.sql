-- Puts back the table-wide UNIQUE on mprh_pr_refno. Fails (and changes
-- nothing) once two outlets hold debit notes with the same number: delete
-- or renumber those first.
ALTER TABLE `debit_note`
  DROP INDEX `uniq_debit_note_store_pr`,
  ADD UNIQUE KEY `mprh_pr_refno` (`mprh_pr_refno`);
