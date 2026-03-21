ALTER TABLE pick_pack_write_off
  ADD COLUMN reason_employee_id INT NULL COMMENT 'FK to new_employee' AFTER remark_str,
  ADD COLUMN is_verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=verified, 0=not verified' AFTER reason_employee_id,
  ADD CONSTRAINT fk_pick_pack_write_off_reason_employee_id
    FOREIGN KEY (reason_employee_id) REFERENCES new_employee(employee_id) ON DELETE SET NULL,
  ADD INDEX idx_pick_pack_write_off_is_verified (is_verified);
