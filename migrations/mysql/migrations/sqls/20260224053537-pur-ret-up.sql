CREATE TABLE purchase_return_extra (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mprh_pr_no VARCHAR(50) NOT NULL,
  no_of_boxes INT DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'open' COMMENT 'open, done',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_mprh_pr_no (mprh_pr_no)
);

CREATE INDEX idx_purchase_return_extra_status ON purchase_return_extra(status);

ALTER TABLE purchase_return_extra
  ADD COLUMN distributor_id VARCHAR(50) NULL AFTER status;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_purchase_return');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_purchase_return');