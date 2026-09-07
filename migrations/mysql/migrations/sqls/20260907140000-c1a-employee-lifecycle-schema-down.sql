-- Stage 0C / C1a — undo. Removes exactly what the up added, in dependency
-- order, and touches nothing else. `new_employee` was never modified, so
-- rolling back leaves the employee master byte-identical to before.
--
-- Safe while the tables are empty (C1a) and after C1b, whose rows live only
-- in `employee_employment_period`. Once C1c is live and real lifecycle
-- history exists, dropping these tables discards that history - so a
-- rollback past C1c is a decision, not a routine step.

DROP VIEW IF EXISTS `v_employee_current_period`;

-- The foreign keys must go before the columns they live on.
ALTER TABLE `resignation`
  DROP FOREIGN KEY `fk_resignation_period`;
ALTER TABLE `resignation`
  DROP FOREIGN KEY `fk_resignation_employee`;
ALTER TABLE `resignation`
  DROP KEY `idx_resignation_period`,
  DROP KEY `idx_resignation_employee`,
  DROP COLUMN `voided_by`,
  DROP COLUMN `voided_at`,
  DROP COLUMN `period_id`,
  DROP COLUMN `employee_id`;

-- Events reference periods, so they go first.
DROP TABLE IF EXISTS `employee_lifecycle_event`;
DROP TABLE IF EXISTS `employee_employment_period`;
