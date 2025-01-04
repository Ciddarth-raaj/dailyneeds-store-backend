INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_account_sheet');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_master_list');

CREATE TABLE `people_list` (`person_id` INT NOT NULL AUTO_INCREMENT , `name` VARCHAR(200) NOT NULL , `primary_phone` VARCHAR(15) NULL , `secondary_phone` VARCHAR(15) NULL , `person_type` INT NOT NULL , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , PRIMARY KEY (`person_id`)) ENGINE = InnoDB;