CREATE TABLE `department_table` ( `department_id` INT NOT NULL, `department_name` VARCHAR(45) NULL, `image_url` VARCHAR(45) NULL, `is_hidden` TINYINT NULL DEFAULT 0, `status` int DEFAULT '1', `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (`department_id`));