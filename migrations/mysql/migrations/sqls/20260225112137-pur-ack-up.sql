INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_purchase_acknowledgement');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_purchase_acknowledgement');

CREATE TABLE IF NOT EXISTS purchase_acknowledgement (
  purchase_acknowledgement_id INT AUTO_INCREMENT PRIMARY KEY,
  distributor_id VARCHAR(50) NOT NULL COMMENT 'MDM_DIST_CODE from medishopdb_MED_DISTRIBUTOR_MAST',
  invoice_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  created_by INT NULL COMMENT 'employee_id from new_employee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_purchase_acknowledgement_created_by
    FOREIGN KEY (created_by) REFERENCES new_employee(employee_id) ON DELETE SET NULL
);
