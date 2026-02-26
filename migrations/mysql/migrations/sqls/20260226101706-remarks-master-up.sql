INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_remarks_master');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_remarks_master');


CREATE TABLE IF NOT EXISTS remarks_master (
  remark_id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=active, 0=inactive',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

ALTER TABLE purchase_return_extra
  ADD COLUMN remark_id INT NULL COMMENT 'FK to remarks_master' AFTER purchase_acknowledgement_id,
  ADD COLUMN remark VARCHAR(500) NULL AFTER remark_id;