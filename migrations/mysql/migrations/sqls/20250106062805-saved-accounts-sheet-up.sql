CREATE TABLE `accounts_saved` (`sheet_date` DATE NOT NULL , `store_id` INT NOT NULL , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ) ENGINE = InnoDB;
ALTER TABLE `accounts_saved` ADD UNIQUE(`sheet_date`, `store_id`);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('save_account_sheet');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('unsave_account_sheet');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_store_budget');