-- Reverses the Payrun Initialization migration.
--
-- The audit table goes first: it has a foreign key onto `payrun_employee` and
-- dropping the parent while the child exists would fail.
--
-- The permission key is NOT deleted. `all_permissions` is a catalogue, and a
-- designation may have been granted this key in the meantime; deleting the row
-- would leave `permissions` pointing at a key that no longer exists, which is
-- the state every other down-migration in this schema avoids.
DROP TABLE IF EXISTS `payrun_employee_pay_type_audit`;
DROP TABLE IF EXISTS `payrun_employee`;
DROP TABLE IF EXISTS `payrun_period`;
