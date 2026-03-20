INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_pick_pack_remarks');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_pick_pack_remarks');

CREATE TABLE IF NOT EXISTS pick_pack_remarks (
  remark_id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=active, 0=inactive',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
