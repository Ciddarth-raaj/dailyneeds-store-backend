-- Removes ONLY what the Phase 3A up-migration created.
--
-- One table, and nothing else. No permission is revoked because none was
-- created; the registry's two keys predate this migration and are left
-- exactly as they are. `telegram_group_registry`, `outlets`, `designation`,
-- `department` and `new_employee` are untouched - this table pointed at them
-- and never owned anything in them.

DROP TABLE IF EXISTS `telegram_group_mapping`;
