START TRANSACTION;

CREATE TABLE `accounts_message` (`sheet_date` INT NOT NULL , `store_id` INT NOT NULL , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ) ENGINE = InnoDB;
ALTER TABLE `accounts_message` ADD UNIQUE(`sheet_date`, `store_id`);
ALTER TABLE `accounts_message` CHANGE `sheet_date` `sheet_date` DATE NOT NULL;

COMMIT;