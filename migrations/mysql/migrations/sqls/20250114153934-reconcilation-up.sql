INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_sales_reconciliation');
ALTER TABLE `accounts_sales` ADD `is_checked` BOOLEAN NOT NULL DEFAULT FALSE AFTER `amount`;