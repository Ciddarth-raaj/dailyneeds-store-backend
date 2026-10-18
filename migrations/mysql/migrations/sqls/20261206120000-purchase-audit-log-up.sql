-- Purchase audit trail: Accounts' corrections on the Purchase screen (each
-- changed field, from -> to), approvals, and Tally response deletions, with
-- who did it. Original RetailPilot values stay in purchase.retailpilot_source.
-- No foreign key, so the history outlives the purchase row. New table: no
-- lock on existing tables.
CREATE TABLE IF NOT EXISTS `purchase_audit_log` (
  `purchase_audit_log_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purchase_id` BIGINT NOT NULL,
  `action` VARCHAR(40) NOT NULL,
  `actor_user_id` INT NULL,
  `actor_employee_id` INT NULL,
  `detail` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`purchase_audit_log_id`),
  KEY `idx_purchase_audit_log_purchase` (`purchase_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
