INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_purchase_order');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_purchase_order');

-- Purchase Order Table
CREATE TABLE purchase_order (
    purchase_order_id INT AUTO_INCREMENT PRIMARY KEY,
    purchase_order_ref VARCHAR(255),
    date DATE,
    delivery_date DATE,
    discount DECIMAL(10,2) DEFAULT 0.00,
    adjustment DECIMAL(10,2) DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Purchase Order Items Table
CREATE TABLE purchase_order_items (
    purchase_order_item_id INT AUTO_INCREMENT PRIMARY KEY,
    purchase_order_id INT NOT NULL,
    material_id INT NOT NULL,
    quantity INT NOT NULL,
    rate DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_order(purchase_order_id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES materials_latest(material_id) ON DELETE RESTRICT
);

-- Indexes for better performance
CREATE INDEX idx_purchase_order_ref ON purchase_order(purchase_order_ref);
CREATE INDEX idx_purchase_order_date ON purchase_order(date);
CREATE INDEX idx_purchase_order_status ON purchase_order(status);
CREATE INDEX idx_purchase_order_items_po_id ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_items_material_id ON purchase_order_items(material_id);

ALTER TABLE `purchase_order` ADD `vendor_id` INT NOT NULL AFTER `purchase_order_ref`;

ALTER TABLE purchase_order_items ADD COLUMN stock INT DEFAULT 0 AFTER rate;

ALTER TABLE purchase_order ADD COLUMN tax DECIMAL(10,2) DEFAULT 0.00 AFTER adjustment;

ALTER TABLE purchase_order ADD COLUMN pdf_url TEXT NULL COMMENT 'URL of the generated PDF file'; 

ALTER TABLE `purchase_order` CHANGE `pdf_url` `pdf_url` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT 'URL of the generated PDF file' AFTER `tax`