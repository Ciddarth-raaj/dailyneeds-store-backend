CREATE TABLE product_image_log (
    product_image_log_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    change_json JSON NOT NULL COMMENT 'Image array that was applied in the update',
    created_by INT NOT NULL COMMENT 'employee_id from new_employee (employee code)',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES product_table(product_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES new_employee(employee_id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_image_log_product_id ON product_image_log(product_id);
CREATE INDEX idx_product_image_log_created_by ON product_image_log(created_by);
CREATE INDEX idx_product_image_log_created_at ON product_image_log(created_at);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_products_dashboard');