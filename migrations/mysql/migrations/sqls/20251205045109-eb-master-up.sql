CREATE TABLE `eb_master_list` (`eb_machine_id` INT NOT NULL AUTO_INCREMENT , `machine_number` VARCHAR(20) NOT NULL , `nickname` VARCHAR(50) NULL , `store_id` INT NOT NULL , `is_active` BOOLEAN NOT NULL DEFAULT TRUE , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , `updated_at` TIMESTAMP on update CURRENT_TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , PRIMARY KEY (`eb_machine_id`)) ENGINE = InnoDB;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_eb_machine_master');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_eb_machine_master');