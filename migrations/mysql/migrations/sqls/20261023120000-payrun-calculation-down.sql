-- Reverses the Payrun Calculation & Review migration.
--
-- The audit table goes first: it has a foreign key onto `payrun_employee` and
-- dropping it after the calculation would leave the order to chance.
--
-- The permission key is NOT deleted, for the reason the initialization
-- down-migration records: `all_permissions` is a catalogue, a designation may
-- have been granted `approve_payrun` in the meantime, and deleting the row
-- would leave `permissions` pointing at a key that no longer exists.
DROP TABLE IF EXISTS `payrun_employee_calculation_audit`;
DROP TABLE IF EXISTS `payrun_employee_calculation`;
