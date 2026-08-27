INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_product_changes');

CREATE TABLE IF NOT EXISTS products_changes (
  products_change_id INT AUTO_INCREMENT PRIMARY KEY,
  product_id         VARCHAR(64)   NOT NULL,
  changes            JSON          NOT NULL,
  is_approved        TINYINT(1)    NOT NULL DEFAULT 0,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
