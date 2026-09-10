INSERT INTO `all_permissions` (`permission_key`) VALUES ('ignore_grn_issues');

CREATE TABLE IF NOT EXISTS grn_issue_ignores (
  grn_issue_ignore_id INT AUTO_INCREMENT PRIMARY KEY,
  mmh_mrc_refno VARCHAR(50) NOT NULL,
  mmd_mrc_sl_no VARCHAR(50) NOT NULL,
  product_id INT NULL,
  ignored_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_grn_issue_ignores_refno_sl_no (mmh_mrc_refno, mmd_mrc_sl_no)
);
