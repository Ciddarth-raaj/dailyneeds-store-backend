INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_account_sheet');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_master_list');

CREATE TABLE `people_list` (`person_id` INT NOT NULL AUTO_INCREMENT , `name` VARCHAR(200) NOT NULL , `primary_phone` VARCHAR(15) NULL , `secondary_phone` VARCHAR(15) NULL , `person_type` INT NOT NULL , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , PRIMARY KEY (`person_id`)) ENGINE = InnoDB;
ALTER TABLE `people_list` ADD `store_id` INT NOT NULL AFTER `person_type`;
ALTER TABLE `people_list` DROP `store_id`;
CREATE TABLE `people_list_outlets_map` (`store_id` INT NOT NULL , `person_id` INT NOT NULL ) ENGINE = InnoDB;
ALTER TABLE `people_list_outlets_map` ADD UNIQUE(`store_id`, `person_id`);