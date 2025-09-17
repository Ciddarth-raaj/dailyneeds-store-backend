INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_items');

CREATE TABLE `repack_items_master` (
    `item_id` INT PRIMARY KEY,
    `cleaning` BOOLEAN DEFAULT NULL,
    `packing_type` INT DEFAULT NULL,
    `packing_material` INT DEFAULT NULL,
    `packing_material_size` INT DEFAULT NULL,
    `sticker` BOOLEAN DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`item_id`) REFERENCES `product_table`(`product_id`) ON DELETE RESTRICT
) ENGINE = InnoDB;