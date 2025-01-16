INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_payment_receipts_reconciliation');

CREATE TABLE `accounts_reconciliation_sales` (`bill_date` DATE NOT NULL , `store_id` INT NOT NULL , `loyalty_diff` DECIMAL NOT NULL , `sales_diff` DECIMAL NOT NULL , `return_diff` INT NOT NULL , `created_at` INT NOT NULL ) ENGINE = InnoDB;
ALTER TABLE `accounts_reconciliation_sales` ADD UNIQUE(`bill_date`, `store_id`);
ALTER TABLE `accounts_reconciliation_sales` CHANGE `created_at` `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;