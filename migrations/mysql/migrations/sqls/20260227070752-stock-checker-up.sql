-- 1. stock_checker
CREATE TABLE IF NOT EXISTS stock_checker (
  stock_checker_id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  created_by INT NULL COMMENT 'employee_id from new_employee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES product_table(product_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES new_employee(employee_id) ON DELETE SET NULL
);

CREATE INDEX idx_stock_checker_product_id ON stock_checker(product_id);
CREATE INDEX idx_stock_checker_created_by ON stock_checker(created_by);

-- 2. stock_checker_items (unique on stock_checker_id + branch_id)
CREATE TABLE IF NOT EXISTS stock_checker_items (
  stock_checker_id INT NOT NULL,
  branch_id INT NOT NULL,
  physical_stock DECIMAL(15,4) NOT NULL DEFAULT 0,
  system_stock DECIMAL(15,4) NOT NULL DEFAULT 0,
  created_by INT NULL COMMENT 'employee_id from new_employee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (stock_checker_id, branch_id),
  FOREIGN KEY (stock_checker_id) REFERENCES stock_checker(stock_checker_id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES outlets(outlet_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES new_employee(employee_id) ON DELETE SET NULL
);

CREATE INDEX idx_stock_checker_items_created_by ON stock_checker_items(created_by);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_stock_checker');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_stock_checker');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_assigned_products');

ALTER TABLE `stock_checker_items` CHANGE `physical_stock` `physical_stock` INT NOT NULL DEFAULT '0', CHANGE `system_stock` `system_stock` INT NOT NULL DEFAULT '0';