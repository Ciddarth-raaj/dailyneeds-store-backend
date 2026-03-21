INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_product_distributor');

CREATE TABLE IF NOT EXISTS product_distributor (
  mdm_dist_code VARCHAR(64) NOT NULL PRIMARY KEY COMMENT 'Matches MDM_DIST_CODE from distributor master',
  buyer_id INT NULL COMMENT 'FK to new_employee (buyer)',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_distributor_buyer_id
    FOREIGN KEY (buyer_id) REFERENCES new_employee(employee_id) ON DELETE SET NULL,
  INDEX idx_product_distributor_buyer_id (buyer_id)
);
