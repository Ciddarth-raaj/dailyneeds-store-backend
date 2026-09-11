-- DigiSME Excel attendance import (Part 1, permanent fallback path).
--
-- Imported punches live in the SAME biomax_punch table as live device
-- punches, so the Attendance List and Punch Audit read one table. That
-- needs four small, guarded, non-destructive changes to biomax_punch and
-- two new staging tables. No existing row is rewritten: every current punch
-- keeps its dev_id, its raw_json and its ingest_source exactly as it is.
--
-- Design: docs/biomax-attendance-import.md.

-- ======================================== 1. biomax_punch: nullable dev_id
-- An imported punch has no terminal. MODIFY keeps type, charset and every
-- existing value; only the NOT NULL constraint is dropped. Guarded on
-- IS_NULLABLE so the file re-runs cleanly.
SET @dev_id_nullable = (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'dev_id'
);
SET @sql = IF(@dev_id_nullable = 'NO',
  'ALTER TABLE `biomax_punch` MODIFY COLUMN `dev_id` VARCHAR(32) NULL COMMENT ''header dev_id, verbatim - free text, NOT an FK (R7). NULL = not from a terminal (imported)''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ====================================== 2. biomax_punch: nullable raw_json
-- No BM70W JSON exists for an imported punch, and none is invented.
SET @raw_json_nullable = (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'raw_json'
);
SET @sql = IF(@raw_json_nullable = 'NO',
  'ALTER TABLE `biomax_punch` MODIFY COLUMN `raw_json` TEXT NULL COMMENT ''the JSON object bytes exactly as received - NULL for an imported punch''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================ 3. biomax_punch: ingest_source DIGISME_IMPORT
-- Appending a value to an ENUM is a metadata-only change; LIVE and
-- HISTORICAL_PULL keep their positions and every existing row its value.
SET @ingest_type = (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'ingest_source'
);
SET @sql = IF(@ingest_type NOT LIKE '%DIGISME_IMPORT%',
  'ALTER TABLE `biomax_punch` MODIFY COLUMN `ingest_source` ENUM(''LIVE'',''HISTORICAL_PULL'',''DIGISME_IMPORT'') NOT NULL DEFAULT ''LIVE'' COMMENT ''how the row got here - LIVE realtime_glog, a historical GET_LOG_DATA pull, or a DigiSME Excel import''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================== 4. biomax_punch: import dedup + batch link
-- The device dedup key (dev_id, user_id, io_time_raw) cannot protect rows
-- whose dev_id is NULL: MySQL treats every NULL as distinct in a UNIQUE key.
-- So a STORED generated column carries "source|code|time" for terminal-less
-- rows and NULL for device rows, and a UNIQUE index on it makes a repeated
-- or concurrent import of the same DigiSME punch a database error, not a
-- race. Device rows are untouched by it (NULLs never collide), and a LIVE
-- punch never collides with an imported one (different key), which is what
-- keeps a cross-source collision preservable.
SET @has_dedup = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'import_dedup_key'
);
SET @sql = IF(@has_dedup = 0,
  'ALTER TABLE `biomax_punch` ADD COLUMN `import_dedup_key` VARCHAR(96) GENERATED ALWAYS AS (CASE WHEN `dev_id` IS NULL THEN CONCAT(`ingest_source`, ''|'', `user_id`, ''|'', `io_time_raw`) ELSE NULL END) STORED COMMENT ''dedup key for terminal-less rows - NULL for device rows'', ADD UNIQUE KEY `uq_biomax_punch_import_dedup` (`import_dedup_key`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @has_batch = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'import_batch_id'
);
SET @sql = IF(@has_batch = 0,
  'ALTER TABLE `biomax_punch` ADD COLUMN `import_batch_id` BIGINT UNSIGNED NULL COMMENT ''biomax_attendance_import_batch that created this row - NULL for device rows'', ADD KEY `idx_biomax_punch_import_batch` (`import_batch_id`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ================================================= 5. import batch (audit)
-- One row per uploaded file, kept forever: who, when previewed, when
-- committed, the file's name and SHA-256, the date range and every count.
-- The Excel binary itself is not stored.
CREATE TABLE IF NOT EXISTS `biomax_attendance_import_batch` (
  `import_batch_id`     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_type`         ENUM('DIGISME_ATD_DAILY') NOT NULL DEFAULT 'DIGISME_ATD_DAILY',
  `original_filename`   VARCHAR(255) NOT NULL,
  `file_sha256`         CHAR(64) NOT NULL,
  `file_size_bytes`     INT UNSIGNED NOT NULL DEFAULT 0,
  `sheet_name`          VARCHAR(64) NOT NULL,
  `time_columns`        VARCHAR(512) NULL COMMENT 'the Clock Time-N headers found, comma separated',
  `status`              ENUM('PREVIEWED','COMMITTING','COMMITTED','COMMITTED_WITH_ERRORS','FAILED') NOT NULL DEFAULT 'PREVIEWED',
  `uploaded_by`         INT NULL COMMENT 'new_employee.employee_id of the administrator',
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `previewed_at`        DATETIME(3) NULL,
  `committed_at`        DATETIME(3) NULL,
  `committed_by`        INT NULL,
  `excel_row_count`     INT NOT NULL DEFAULT 0 COMMENT 'data rows below the header',
  `employee_code_count` INT NOT NULL DEFAULT 0 COMMENT 'distinct Employee Code values seen',
  `candidate_count`     INT NOT NULL DEFAULT 0 COMMENT 'non-empty Clock Time cells',
  `valid_count`         INT NOT NULL DEFAULT 0,
  `bad_count`           INT NOT NULL DEFAULT 0,
  `unmatched_count`     INT NOT NULL DEFAULT 0,
  `reimport_duplicate_count` INT NOT NULL DEFAULT 0,
  `cross_source_collision_count` INT NOT NULL DEFAULT 0,
  `imported_count`      INT NOT NULL DEFAULT 0 COMMENT 'biomax_punch rows created by commit',
  `skipped_count`       INT NOT NULL DEFAULT 0,
  `failed_count`        INT NOT NULL DEFAULT 0,
  `date_from`           DATE NULL COMMENT 'earliest calendar date among valid punches',
  `date_to`             DATE NULL,
  `error_message`       VARCHAR(255) NULL,
  PRIMARY KEY (`import_batch_id`),
  KEY `idx_baib_created` (`created_at`),
  KEY `idx_baib_sha` (`file_sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================ 6. import items (staging)
-- One row per candidate punch (a non-empty Clock Time cell) and one per
-- rejected Excel row, with enough provenance to answer where it came from.
-- COMMIT works from these rows, never from the file again.
CREATE TABLE IF NOT EXISTS `biomax_attendance_import_item` (
  `import_item_id`      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `import_batch_id`     BIGINT UNSIGNED NOT NULL,
  `excel_row`           INT NOT NULL,
  `column_name`         VARCHAR(32) NULL COMMENT 'Clock Time-N header - NULL for a row-level problem',
  `raw_employee_code`   VARCHAR(64) NULL,
  `raw_clock_date`      VARCHAR(64) NULL,
  `raw_clock_time`      VARCHAR(64) NULL,
  `user_id`             VARCHAR(32) NULL COMMENT 'canonical Employee Code as it will be stored on the punch',
  `io_time_raw`         CHAR(14) NULL,
  `employee_id`         INT NULL COMMENT 'resolved at preview - NULL = unmatched',
  `classification`      ENUM('VALID','UNMATCHED_EMPLOYEE','BAD_ROW','REIMPORT_DUPLICATE','CROSS_SOURCE_COLLISION') NOT NULL,
  `derivation_status`   VARCHAR(20) NULL COMMENT 'attendance-date status at preview (OK, NO_SHIFT, ...)',
  `attendance_date`     DATE NULL COMMENT 'as derived at preview - informational',
  `collided_punch_id`   BIGINT UNSIGNED NULL COMMENT 'the existing non-import punch at the same employee + time',
  `message`             VARCHAR(255) NULL,
  `outcome`             ENUM('IMPORTED','IMPORTED_UNMATCHED','IMPORTED_WITH_COLLISION','SKIPPED_REIMPORT_DUPLICATE','SKIPPED_BAD_ROW','FAILED') NULL,
  `biomax_punch_id`     BIGINT UNSIGNED NULL,
  `committed_at`        DATETIME(3) NULL,
  PRIMARY KEY (`import_item_id`),
  KEY `idx_baii_batch_class` (`import_batch_id`, `classification`),
  KEY `idx_baii_batch_outcome` (`import_batch_id`, `outcome`),
  KEY `idx_baii_batch_row` (`import_batch_id`, `excel_row`),
  CONSTRAINT `fk_baii_batch` FOREIGN KEY (`import_batch_id`) REFERENCES `biomax_attendance_import_batch` (`import_batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ====================================================== 7. permission ====
-- Importing attendance is its own decision. Declared, granted to NOBODY:
-- administrators pass through the user_type 2 bypass.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_attendance_import' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_import');
