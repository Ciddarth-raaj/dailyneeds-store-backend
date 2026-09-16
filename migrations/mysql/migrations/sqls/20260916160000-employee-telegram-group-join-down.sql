-- Removes ONLY what the Phase 3B up-migration created.
--
-- One table. No permission is revoked because none was created, and
-- `employee_telegram_identity`, `telegram_group_registry`,
-- `telegram_group_mapping` and `new_employee` are untouched - this table
-- referenced them and owned nothing in them.

DROP TABLE IF EXISTS `employee_telegram_group_join_attempt`;
