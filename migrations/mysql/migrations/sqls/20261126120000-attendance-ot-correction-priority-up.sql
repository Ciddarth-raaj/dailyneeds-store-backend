-- =====================================================================
-- ATTENDANCE CORRECTION BEFORE SYSTEM OT
--
-- 1. A SYSTEM-RAISED pending OT (`auto_created = 1`) gets its OWN open-request
--    group, AUTO_OT, so it no longer holds the date's 'ATT' slot that an
--    employee / HR regularization needs. A correction can always be raised;
--    the OT waits for it (the approval is refused while a correction is
--    pending on the date - `repository/attendance_regularization.js#decideStage`)
--    and is re-synced from the corrected day afterwards.
--    Manual requests keep the existing rule: one open 'ATT' request a date
--    (a regularization, or a legacy employee-raised OT), one 'SHIFT', one
--    'PERM'.
--
-- 2. AT MOST ONE PENDING OT-CARRYING REQUEST A DATE, whoever raised it: a
--    second key on a generated column that is the date only while an OT or a
--    REGULARIZATION_WITH_OT is PENDING. Moving system OT out of 'ATT' must
--    not let a system OT and a legacy manual OT be pending side by side.
--
-- 3. attendance_ot_deferred_sync: a TRIGGER, never an OT record. The deploy
--    backfill (--apply only) remembers each historical date in an employee's
--    5-attendance-day window that had an attendance correction open, so the
--    correction's final decision can re-run the ordinary OT sync for THAT
--    date even though it is before the global cutover. One row per employee
--    and date; the cutover itself is never moved.
--
-- EXISTING ROWS: none is rewritten. The new key cannot be violated by
-- existing data (OT and REGULARIZATION_WITH_OT were both 'ATT', which already
-- allowed one pending request per date).
-- =====================================================================

-- ====================================== 1. the open-request groups =========
-- ONE statement: the generated expression is MODIFIED in place (a stored
-- generated column's expression may be changed this way), so the existing
-- unique key stays and a failure leaves the table exactly as it was - MySQL
-- DDL is not transactional, and a drop-then-add that failed half-way would
-- leave the table with no open-request key at all.
ALTER TABLE `attendance_approval_request`
  MODIFY COLUMN `open_request_group` ENUM('ATT','SHIFT','PERM','AUTO_OT') GENERATED ALWAYS AS
    (CASE WHEN `status` = 'PENDING'
          THEN (CASE WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT'
                     WHEN `request_type` = 'PERMISSION' THEN 'PERM'
                     WHEN `request_type` = 'OT' AND `auto_created` = 1 THEN 'AUTO_OT'
                     ELSE 'ATT' END)
          ELSE NULL END) STORED;

-- ============================ 2. one pending OT-carrying request a date ====
-- Guarded like the other OT migrations' column additions, so a re-run is
-- harmless; column and key in ONE statement.
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'attendance_approval_request'
                  AND `COLUMN_NAME` = 'open_ot_attendance_date') = 0,
  'ALTER TABLE `attendance_approval_request`
     ADD COLUMN `open_ot_attendance_date` DATE GENERATED ALWAYS AS
       (CASE WHEN `status` = ''PENDING'' AND `request_type` IN (''OT'',''REGULARIZATION_WITH_OT'')
             THEN `attendance_date` ELSE NULL END) STORED,
     ADD UNIQUE KEY `uq_aareq_open_ot_per_employee_date`
       (`requested_for_employee_id`, `open_ot_attendance_date`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================== 3. deferred historical OT re-evaluation ===
CREATE TABLE IF NOT EXISTS `attendance_ot_deferred_sync` (
  `deferred_sync_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,
  `reason` VARCHAR(48) NOT NULL DEFAULT 'BLOCKED_BY_OPEN_REQUEST',
  `blocking_request_id` BIGINT UNSIGNED NULL COMMENT 'the open correction when last checked',
  `blocking_request_type` VARCHAR(32) NULL,
  `eligible_ot_minutes` INT NULL COMMENT 'eligible OT on the uncorrected day, when deferred',
  `status` ENUM('WAITING_FOR_CORRECTION','RESOLVED') NOT NULL DEFAULT 'WAITING_FOR_CORRECTION',
  `resolution` VARCHAR(48) NULL COMMENT 'CREATED, UPDATED, UNCHANGED, NO_OT, WITHDRAWN, PRESERVED_DECIDED, PAYROLL_LOCKED, ...',
  `resolved_request_id` BIGINT UNSIGNED NULL COMMENT 'the OT request the sync created or found',
  `source` VARCHAR(32) NOT NULL DEFAULT 'BACKFILL',
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolved_at` TIMESTAMP(3) NULL,
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`deferred_sync_id`),
  UNIQUE KEY `uq_aods_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_aods_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `attendance_ot_deferred_sync_log` (
  `deferred_sync_log_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `deferred_sync_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,
  `action` ENUM('DEFERRED','STILL_BLOCKED','SYNC_ATTEMPTED','RESOLVED') NOT NULL,
  `blocking_request_id` BIGINT UNSIGNED NULL,
  `ot_request_id` BIGINT UNSIGNED NULL,
  `detail` VARCHAR(255) NULL,
  `trigger_source` VARCHAR(64) NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`deferred_sync_log_id`),
  KEY `idx_aodsl_deferred` (`deferred_sync_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
