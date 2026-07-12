INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_pick_pack_return_remarks');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_pick_pack_return_remarks');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_pick_pack_returns');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_pick_pack_returns');

CREATE TABLE IF NOT EXISTS pick_pack_return_remarks (
  remark_id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  job_type ENUM('GRN', 'STA') NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=active, 0=inactive',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pick_pack_return_remarks_job_type_active (job_type, is_active)
);

CREATE TABLE IF NOT EXISTS pick_pack_returns (
  pick_pack_return_id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  mismatch_qty INT NOT NULL DEFAULT 0,
  date DATE NOT NULL,
  job_type ENUM('GRN', 'STA') NOT NULL,
  remark_id INT NULL,
  remark_str VARCHAR(500) NULL,
  is_verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=verified, 0=not verified',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pick_pack_returns_product_id
    FOREIGN KEY (product_id) REFERENCES product_table(product_id),
  CONSTRAINT fk_pick_pack_returns_remark_id
    FOREIGN KEY (remark_id) REFERENCES pick_pack_return_remarks(remark_id) ON DELETE SET NULL,
  INDEX idx_pick_pack_returns_date (date),
  INDEX idx_pick_pack_returns_product_id (product_id),
  INDEX idx_pick_pack_returns_remark_id (remark_id),
  INDEX idx_pick_pack_returns_job_type (job_type),
  INDEX idx_pick_pack_returns_job_type_date (job_type, date),
  INDEX idx_pick_pack_returns_is_verified (is_verified)
);
