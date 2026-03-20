INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_pick_pack_write_off');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_pick_pack_write_off');

CREATE TABLE IF NOT EXISTS pick_pack_write_off (
  pick_pack_write_off_id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  mismatch_qty INT NOT NULL DEFAULT 0,
  date DATE NOT NULL,
  remark_id INT NULL,
  remark_str VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pick_pack_write_off_product_id
    FOREIGN KEY (product_id) REFERENCES product_table(product_id),
  CONSTRAINT fk_pick_pack_write_off_remark_id
    FOREIGN KEY (remark_id) REFERENCES pick_pack_remarks(remark_id) ON DELETE SET NULL,
  INDEX idx_pick_pack_write_off_date (date),
  INDEX idx_pick_pack_write_off_product_id (product_id),
  INDEX idx_pick_pack_write_off_remark_id (remark_id)
);
