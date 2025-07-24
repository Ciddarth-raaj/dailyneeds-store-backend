CREATE TABLE material_request (
    material_request_id INT AUTO_INCREMENT PRIMARY KEY,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE material_request_list (
    material_request_list_id INT AUTO_INCREMENT PRIMARY KEY,
    material_request_id INT NOT NULL,
    material_id INT NOT NULL,
    quantity INT NOT NULL,
    remark VARCHAR(255),
    FOREIGN KEY (material_request_id) REFERENCES material_request(material_request_id)
);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_materials_request');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_materials_request');

ALTER TABLE `material_request` ADD `outlet_id` INT NOT NULL AFTER `created_by`, ADD `is_approved` INT NOT NULL AFTER `outlet_id`;

ALTER TABLE `material_request` ADD FOREIGN KEY (outlet_id) REFERENCES outlets(outlet_id);
ALTER TABLE `material_request` ADD FOREIGN KEY (created_by) REFERENCES new_employee(employee_id);

ALTER TABLE `materials_latest` DROP `sku_code`;
ALTER TABLE `materials_latest` ADD `description` TEXT NOT NULL AFTER `name`;
ALTER TABLE `materials_latest` CHANGE `unit_id` `unit_id` INT NULL;

ALTER TABLE `materials_latest` CHANGE `description` `description` TEXT CHARACTER SET utf8 COLLATE utf8_general_ci NULL;