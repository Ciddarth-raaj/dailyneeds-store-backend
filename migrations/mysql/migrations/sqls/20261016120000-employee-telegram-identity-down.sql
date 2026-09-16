-- Reverses the Phase 2 employee Telegram identity migration.
--
-- Dropped in dependency order - nothing references these three, and they
-- reference only `new_employee`, which is left exactly as it was. No data
-- outside them is read or written, so a down migration cannot damage an
-- employee record.
DROP TABLE IF EXISTS `employee_telegram_audit`;
DROP TABLE IF EXISTS `employee_telegram_link_tokens`;
DROP TABLE IF EXISTS `employee_telegram_identity`;
