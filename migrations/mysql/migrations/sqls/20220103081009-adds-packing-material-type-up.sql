CREATE TABLE `pack_material_type` ( `type_id` INT NOT NULL AUTO_INCREMENT, `material_type` VARCHAR(45) NULL, `description` LONGTEXT NULL, `status` TINYINT NULL DEFAULT '1', PRIMARY KEY (`type_id`));