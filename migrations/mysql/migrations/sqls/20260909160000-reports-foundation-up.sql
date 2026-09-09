-- Reports — saved templates and the export audit trail.
--
-- ADDITIVE ONLY. Two new tables and five seeded system templates. Nothing
-- existing is altered: no employee row, no employee ID, no lifecycle period,
-- no Aadhaar or bank record, no permission grant.
--
-- Timestamped after 20260909120000, the last migration actually in production,
-- and dated today.
--
-- It previously carried a future date, 20260911120000, to sit after
-- 20260910120000 - the effective-dated history migration on the FROZEN branch
-- stage0c/c3-hr-master-final. That was the wrong trade: reserving ordering
-- around an undeployed branch dates this file into the future for a collision
-- that may never happen, and db-migrate orders by what has actually run. If
-- that redesign is ever revived, it is the one to renumber, since it will then
-- be the newer change.
--
-- Guarded so the whole file can be re-run without error.

-- ================================================== 1. saved templates ===
-- A template is an INSTRUCTION, not a snapshot of a result. It stores which
-- dataset, which fields in which order, and which filter values - and nothing
-- about how any of that becomes a query.
--
-- WHAT IS DELIBERATELY NOT STORED: SQL, table names, column names, JOIN text,
-- WHERE fragments, operators. A template that stored SQL would be a stored
-- query engine, and every permission check would then be racing a string
-- somebody saved months ago. Field keys are semantic and are revalidated
-- against the catalogue and the caller's permissions on every single run.
CREATE TABLE IF NOT EXISTS `report_template` (
  `template_id`     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_name`   VARCHAR(120) NOT NULL,
  `dataset_key`     VARCHAR(40) NOT NULL,

  -- ONE ordered JSON array of semantic field keys. There is deliberately no
  -- separate `column_order`: two columns describing one thing is two things
  -- to keep in step, and they would eventually disagree about which column
  -- comes third. Array position IS the column order.
  `field_keys`      JSON NOT NULL,

  -- Filter VALUES only - status, outlet ids, department ids, designation ids,
  -- a search string. Never an operator.
  `filters`         JSON NULL DEFAULT NULL,

  -- NULL owner means a system template. Kept nullable rather than pointing at
  -- a service account, so "nobody owns this" is representable.
  `owner_user_id`   INT NULL DEFAULT NULL,
  `is_shared`       TINYINT(1) NOT NULL DEFAULT 0,
  `is_system`       TINYINT(1) NOT NULL DEFAULT 0,

  `created_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`template_id`),
  KEY `idx_template_owner` (`owner_user_id`),
  KEY `idx_template_dataset` (`dataset_key`, `is_system`, `is_shared`),
  -- A system template has no owner, and an owned template is not a system
  -- template. Enforced here so neither can be produced by a bug upstream.
  CONSTRAINT `chk_template_system_owner`
    CHECK ((`is_system` = 1 AND `owner_user_id` IS NULL)
        OR (`is_system` = 0 AND `owner_user_id` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================== 2. the export audit log ===
-- WHO exported WHAT SHAPE of data, and never the data itself.
--
-- The distinction is the whole point: `field_keys` records that PAN was in
-- the export, `filters` records that it covered outlet 2, `row_count` records
-- that it was 216 rows. No PAN, no account number, no UAN, no name, no
-- mobile - not one exported value - is written here. An audit log full of the
-- values it is auditing is a second copy of the leak it was meant to detect.
CREATE TABLE IF NOT EXISTS `report_export_log` (
  `export_id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `dataset_key`               VARCHAR(40) NOT NULL,
  `user_id`                   INT NULL DEFAULT NULL,
  `employee_id`               INT NULL DEFAULT NULL COMMENT 'the acting employee, not a subject of the export',
  `field_keys`                JSON NOT NULL COMMENT 'ordered semantic keys - never values',
  `filters`                   JSON NULL DEFAULT NULL COMMENT 'filter metadata - never row contents',
  `row_count`                 INT NOT NULL DEFAULT 0,
  `format`                    ENUM('xlsx','csv') NOT NULL,
  `sensitive_fields_included` TINYINT(1) NOT NULL DEFAULT 0,
  `template_id`               BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at`                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`export_id`),
  KEY `idx_export_user` (`user_id`, `created_at`),
  KEY `idx_export_dataset` (`dataset_key`, `created_at`),
  KEY `idx_export_sensitive` (`sensitive_fields_included`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================ 3. the system templates =====
-- Reports must not be empty on day one. These are ordinary rows in the table
-- above - the same model user templates use - so the normal list/run/copy API
-- surfaces them with no special-casing in the frontend.
--
-- They still pass every runtime check. A system template naming PF Number
-- shows that column only to somebody who may see it; for everyone else the
-- field is reconciled away with a warning, and the rest of the report runs.
--
-- No Payroll template is seeded, because no Payroll dataset exists.
INSERT INTO `report_template`
  (`template_name`, `dataset_key`, `field_keys`, `filters`, `owner_user_id`, `is_shared`, `is_system`)
SELECT * FROM (
  SELECT
    'Active Employee List' AS `template_name`,
    'EMPLOYEE_MASTER' AS `dataset_key`,
    CAST('["employee_id","employee_name","outlet","department","designation","shift","date_of_joining"]' AS JSON) AS `field_keys`,
    CAST('{"status":"active"}' AS JSON) AS `filters`,
    NULL AS `owner_user_id`, 1 AS `is_shared`, 1 AS `is_system`
  UNION ALL SELECT
    'Contact List', 'EMPLOYEE_MASTER',
    CAST('["employee_id","employee_name","mobile","email","outlet"]' AS JSON),
    CAST('{"status":"active"}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'PF List', 'EMPLOYEE_MASTER',
    CAST('["employee_id","employee_name","uan","pf_number","date_of_joining"]' AS JSON),
    CAST('{"status":"active"}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'ESI List', 'EMPLOYEE_MASTER',
    CAST('["employee_id","employee_name","esi_number","date_of_joining"]' AS JSON),
    CAST('{"status":"active"}' AS JSON), NULL, 1, 1
  UNION ALL SELECT
    'Bank/KYC Status List', 'EMPLOYEE_MASTER',
    CAST('["employee_id","employee_name","outlet","bank_status"]' AS JSON),
    CAST('{"status":"active"}' AS JSON), NULL, 1, 1
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM `report_template` t
   WHERE t.`is_system` = 1 AND t.`template_name` = seed.`template_name`
);

-- ================================================== 4. the permissions ===
-- Declared only, granted to NOBODY by this migration - the discipline C2 used
-- for view_aadhaar_full.
--
-- `view_reports` is discovery and preview. It deliberately does NOT confer
-- access to any field: a caller sees exactly the columns their existing B2/B3
-- permissions already allow, so a report cannot become a way around
-- view_employee_sensitive. `export_reports` is the separate decision to take
-- data out of the building in bulk.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
      SELECT 'view_reports' AS `permission_key`
      UNION ALL SELECT 'export_reports'
      UNION ALL SELECT 'manage_shared_report_templates'
  ) k
  WHERE NOT EXISTS (
    SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key`
  );
