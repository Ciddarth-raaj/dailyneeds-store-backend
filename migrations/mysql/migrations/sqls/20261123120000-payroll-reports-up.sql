-- Payroll Reports - month-wise column layouts, a per-user default template,
-- the built-in payroll templates, and two more export formats in the audit.
--
-- ADDITIVE. No payrun table, no payroll value and no permission grant is
-- touched. Templates reuse the existing `report_template` table (one
-- `dataset_key` per payroll report type) and exports reuse the existing
-- `report_export_log`. No new permission key: Payroll Reports run on
-- view_reports + view_employees + view_payroll + view_salary, export_reports
-- to export, and view_employee_sensitive for the ECR / ESIC files.
--
-- Guarded so the file can be re-run without error.

-- ================================================ 1. month-wise layouts ===
-- The columns ONE user chose for ONE report type in ONE payroll month:
-- scope = user + report type + payroll month. Structure only - field keys,
-- display preferences, reusable filter values - never a payroll figure.
CREATE TABLE IF NOT EXISTS `payroll_report_layout` (
  `layout_id`     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT NOT NULL,
  `report_type`   VARCHAR(32) NOT NULL,
  `period_year`   SMALLINT NOT NULL,
  `period_month`  TINYINT NOT NULL COMMENT '1-12',
  `field_keys`    JSON NOT NULL COMMENT 'ordered semantic keys; array position is column order',
  `display_prefs` JSON NULL DEFAULT NULL,
  `filters`       JSON NULL DEFAULT NULL COMMENT 'reusable filter values only',
  `template_id`   BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'the template this layout was applied from, if any',
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`layout_id`),
  UNIQUE KEY `uq_payroll_report_layout` (`user_id`, `report_type`, `period_year`, `period_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================ 2. default template per type ===
CREATE TABLE IF NOT EXISTS `payroll_report_default_template` (
  `user_id`     INT NOT NULL,
  `report_type` VARCHAR(32) NOT NULL,
  `template_id` BIGINT UNSIGNED NOT NULL,
  `updated_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`, `report_type`),
  KEY `idx_payroll_report_default_template` (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================================ 3. export audit formats ===
-- PDF for the customizable reports, and the two statutory files.
ALTER TABLE `report_export_log`
  MODIFY COLUMN `format` ENUM('xlsx','csv','pdf','ecr','esic') NOT NULL;

-- ================================================= 4. built-in templates ===
-- Ordinary system rows in `report_template`: shared, read-only, copyable,
-- and reconciled against each reader's permissions on every run (a reader
-- without view_employee_sensitive simply does not get the UAN column).
-- `filters.display` holds the display preferences.
INSERT INTO `report_template`
  (`template_name`, `dataset_key`, `field_keys`, `filters`, `owner_user_id`, `is_shared`, `is_system`)
SELECT * FROM (
  SELECT
    'Standard Payroll Register' AS `template_name`,
    'PAYROLL_REGISTER' AS `dataset_key`,
    CAST('["employee_id","employee_name","outlet_department","paid_days","gross_salary","total_deductions","net_pay"]' AS JSON) AS `field_keys`,
    CAST('{"display":{"show_totals":true,"sort_by":null,"sort_dir":"asc"}}' AS JSON) AS `filters`,
    NULL AS `owner_user_id`, 1 AS `is_shared`, 1 AS `is_system`
  UNION ALL SELECT
    'Management Payroll Summary', 'PAYROLL_REGISTER',
    CAST('["employee_id","employee_name","outlet","designation","paid_days","gross_salary","employer_pf_total","employer_esi","total_deductions","net_pay"]' AS JSON),
    CAST('{"display":{"show_totals":true,"sort_by":null,"sort_dir":"asc"}}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'Outlet-wise Payroll', 'PAYROLL_REGISTER',
    CAST('["outlet","department","employee_id","employee_name","paid_days","gross_salary","total_deductions","net_pay"]' AS JSON),
    CAST('{"display":{"show_totals":true,"sort_by":"outlet","sort_dir":"asc"}}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'Audit Payroll', 'PAYROLL_REGISTER',
    CAST('["employee_id","employee_name","outlet","monthly_gross","daily_rate","paid_days","salary_earnings","extra_day_amount","ot_amount","incentive","bonus","arrears","gross_salary","employee_pf","employee_esi","advance_recovery","shortage_recovery","missing_hours_deduction","total_deductions","net_pay_rounding","net_pay","payrun_status","calculation_revision","approved_at"]' AS JSON),
    CAST('{"display":{"show_totals":true,"sort_by":null,"sort_dir":"asc"}}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'Bank Report', 'PAYROLL_BANK',
    CAST('["employee_id","employee_name","bank_name","bank_account_number","bank_ifsc","net_pay"]' AS JSON),
    CAST('{"pay_type":"BANK","display":{"show_totals":true,"sort_by":null,"sort_dir":"asc"}}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'PF Working', 'PAYROLL_EPF',
    CAST('["employee_id","employee_name","uan","gross_salary","epf_wages","eps_wages","edli_wages","employee_pf","employer_eps","employer_epf","edli","pf_admin_charge","ncp_days","eps_status","epf_validation"]' AS JSON),
    CAST('{"display":{"show_totals":true,"sort_by":null,"sort_dir":"asc"}}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'ESI Working', 'PAYROLL_ESI',
    CAST('["employee_id","employee_name","esi_number","esi_days","esi_wages","employee_esi","employer_esi","esi_status","esi_validation"]' AS JSON),
    CAST('{"display":{"show_totals":true,"sort_by":null,"sort_dir":"asc"}}' AS JSON), NULL, 1, 1
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM `report_template` t
   WHERE t.`is_system` = 1 AND t.`template_name` = seed.`template_name` AND t.`dataset_key` = seed.`dataset_key`
);
