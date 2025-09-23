CREATE TABLE `purchase_item` (
    `purchase_item` BIGINT PRIMARY KEY,
    `purchase_item_name` VARCHAR(255) NOT NULL,
    `article_id` INT,
    `article_name` VARCHAR(255),
    `priority_score` FLOAT,
    `repackage_conversion` INT,
    `planner` VARCHAR(255),
    `repack_quantity` INT,
    `forecast_quantity` INT,
    `order_date` DATE,
    `child_stock_in_hand` INT,
    `parent_stock` INT,
    `store_uom` INT,
    `num_stores_oos` INT,
    `chain_bill_count_level` VARCHAR(255),
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`article_id`) REFERENCES `product_table`(`product_id`) ON DELETE SET NULL
);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_cleaning_packing');