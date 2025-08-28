INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_invoice');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_invoice');

CREATE TABLE `invoice` (
    `invoice_id` VARCHAR(100) PRIMARY KEY,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE `invoice_items` (
    `invoice_item_id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `invoice_id` VARCHAR(100) NOT NULL,
    `product_id` INT NOT NULL,
    `quantity` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `cost` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `discount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `tax` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `tax_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `markup_percentage` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    `final_selling_price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `puom` VARCHAR(50) DEFAULT NULL,
    `suom` VARCHAR(50) DEFAULT NULL,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`invoice_id`) ON DELETE CASCADE,
    FOREIGN KEY (`product_id`) REFERENCES `product_table`(`product_id`) ON DELETE RESTRICT
) ENGINE = InnoDB;