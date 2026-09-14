-- Reverses the target binding: drops the index and the column it indexes.
--
-- NOTHING ELSE IS TOUCHED. No employee row, no Aadhaar identity, no verified
-- record, no permission - this migration created none of those.
--
-- ROLLING BACK THE SQL ALONE FAILS LOUDLY rather than silently: with the
-- column gone and the code still deployed, the existing-employee verification
-- routes error instead of quietly reverting to an unbound session. Restoring
-- the previous behaviour means deploying the previous code too, which is what
-- a rollback is.
ALTER TABLE `employee_aadhaar_verification`
  DROP INDEX `idx_aadhaar_verification_target_employee`,
  DROP COLUMN `target_employee_id`;
