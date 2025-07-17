INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_materials');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_materials');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_materials_category');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_materials_category');

CREATE TABLE `materials_latest` (`material_id` INT NOT NULL AUTO_INCREMENT , `name` VARCHAR(200) NOT NULL , `sku_code` VARCHAR(50) NULL DEFAULT NULL , `unit_id` INT NOT NULL , `material_category_id` INT NULL DEFAULT NULL , `is_active` BOOLEAN NOT NULL DEFAULT TRUE , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , `updated_at` TIMESTAMP on update CURRENT_TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , PRIMARY KEY (`material_id`)) ENGINE = InnoDB;
CREATE TABLE `materials_category` (`material_category_id` INT NOT NULL AUTO_INCREMENT , `category_name` VARCHAR(200) NOT NULL , `is_active` BOOLEAN NOT NULL DEFAULT TRUE , `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , `updated_at` TIMESTAMP on update CURRENT_TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP , PRIMARY KEY (`material_category_id`)) ENGINE = InnoDB;