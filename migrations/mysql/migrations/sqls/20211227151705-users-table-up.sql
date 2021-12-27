CREATE TABLE `user` ( `user_id` INT NOT NULL AUTO_INCREMENT , `user_type` INT NOT NULL , `employee_id` INT NULL DEFAULT NULL , `password` TEXT NOT NULL , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , `updated_at` TIMESTAMP on update CURRENT_TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , PRIMARY KEY (`user_id`)) ENGINE = InnoDB;
ALTER TABLE `user` ADD `username` VARCHAR(100) NOT NULL AFTER `user_id`;