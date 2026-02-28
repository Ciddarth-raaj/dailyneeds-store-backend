INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_expiry_checker');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_expiry_checker');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_expiry_assigned_products');

-- products_expiry_checker
CREATE TABLE IF NOT EXISTS products_expiry_checker (
  products_expiry_checker_id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  expiry_date DATE NOT NULL,
  ref_file VARCHAR(2048) NULL COMMENT 'URL to reference file',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES product_table(product_id) ON DELETE RESTRICT
);

CREATE INDEX idx_products_expiry_checker_product_id ON products_expiry_checker(product_id);
CREATE INDEX idx_products_expiry_checker_expiry_date ON products_expiry_checker(expiry_date);

-- products_expiry_checker_items (unique on products_expiry_checker_id + branch_id)
CREATE TABLE IF NOT EXISTS products_expiry_checker_items (
  products_expiry_checker_id INT NOT NULL,
  branch_id INT NOT NULL,
  qty DECIMAL(15,4) NOT NULL DEFAULT 0,
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL COMMENT 'employee_id from new_employee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (products_expiry_checker_id, branch_id),
  FOREIGN KEY (products_expiry_checker_id) REFERENCES products_expiry_checker(products_expiry_checker_id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES outlets(outlet_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES new_employee(employee_id) ON DELETE SET NULL
);

CREATE INDEX idx_products_expiry_checker_items_created_by ON products_expiry_checker_items(created_by);

ALTER TABLE `products_expiry_checker_items` CHANGE `qty` `qty` INT NOT NULL DEFAULT '0';
