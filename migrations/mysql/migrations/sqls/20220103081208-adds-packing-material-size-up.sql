  CREATE TABLE `pack_material_size` ( `size_id` INT NOT NULL AUTO_INCREMENT, `material_size` VARCHAR(45) NULL, `weight` VARCHAR(45) NULL, `cost` VARCHAR(45) NULL, `description` VARCHAR(45) NULL, `status` TINYINT NULL DEFAULT '1', PRIMARY KEY (`size_id`));