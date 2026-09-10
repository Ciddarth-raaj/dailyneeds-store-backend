-- Biomax raw attendance - Part 1.
--
-- ADDITIVE ONLY. Eight new tables, six permission keys, and a seed of the
-- seven Biomax BM70W terminals with their initial location assignments.
-- Nothing existing is altered: no employee row, no outlet, no work shift, no
-- schedule row, no permission grant is revoked.
--
-- NO ATTENDANCE IS CALCULATED BY ANYTHING THIS MIGRATION CREATES. Part 1
-- stores punches exactly as the devices send them and attributes each one to
-- an attendance date. IN/OUT pairing, breaks, grace, lateness, OT, status and
-- payroll are Part 2 and have no table here.
--
-- The design is docs/biomax-attendance-part1.md. The rules cited below (R1,
-- R2, ...) are its numbered rules.
--
-- Two layers, kept apart on purpose (D10):
--
--   biomax_punch          RAW. One row per genuine punch, byte-faithful, and
--                         never UPDATEd or DELETEd after insert (R8) except
--                         the retransmission counter (R2).
--   biomax_punch_derived  DERIVED. Everything that depends on current-state
--                         tables at the moment of ingest: attendance_date,
--                         the employee the code matched, that employee's
--                         home outlet and department, the shift and schedule
--                         row consulted. Written once by the receiver and
--                         rewritten ONLY by an audited re-derivation run.
--
-- Guarded so the whole file can be re-run without error.

-- ============================================================ 1. devices ===
-- One row per physical terminal. `dev_id` is the Cloud ID printed on the
-- unit and sent in every request; it is stored EXACTLY as the device sends
-- it and is never normalised (the supplied inventory contains both the
-- letter O and the digit 0, and they are different devices).
--
-- Location and activity are NOT columns here. They are effective-dated
-- periods in biomax_device_assignment (R17), so moving or replacing a
-- terminal never rewrites where a historical punch happened.
CREATE TABLE IF NOT EXISTS `biomax_device` (
  `biomax_device_id`  INT NOT NULL AUTO_INCREMENT,
  `dev_id`            VARCHAR(32)  NOT NULL COMMENT 'Cloud ID, verbatim. Immutable in normal editing - a correction is an audited event',
  `label`             VARCHAR(100) NOT NULL COMMENT 'e.g. Warehouse - G2',
  `notes`             VARCHAR(255) NULL,
  `first_seen_at`     DATETIME(3) NULL COMMENT 'maintained by the receiver',
  `last_seen_at`      DATETIME(3) NULL COMMENT 'any request, including receive_cmd polls',
  `last_punch_at`     DATETIME(3) NULL COMMENT 'last realtime_glog received',
  `created_by`        INT NULL COMMENT 'new_employee.employee_id of the administrator - NULL = seeded',
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`biomax_device_id`),
  UNIQUE KEY `uq_biomax_device_dev_id` (`dev_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Where a device was, and when. A device is "active" at instant t iff one
-- period contains t: effective_from <= t < effective_to (NULL = open).
-- Moving a terminal = close the current period + open a new one.
-- Decommissioning = close with no successor. Replacing a broken unit = close
-- the old device's period and register the NEW Cloud ID with its own period;
-- the old Cloud ID is never overwritten. Rows are never deleted; a wrong
-- period is closed and a corrected one added, with a note, and every change
-- is recorded in biomax_device_event.
--
-- Several devices may hold open periods at ONE outlet (the warehouse has
-- two), so there is deliberately no unique key on outlet_id. Non-overlap of
-- periods per device is enforced by usecase/biomax_device.js, since MySQL
-- has no exclusion constraint.
--
-- effective_from / effective_to are IST wall-clock DATETIMEs compared
-- against biomax_punch.io_time, which is the same kind of value (R3).
CREATE TABLE IF NOT EXISTS `biomax_device_assignment` (
  `biomax_device_assignment_id` INT NOT NULL AUTO_INCREMENT,
  `biomax_device_id`  INT NOT NULL,
  `outlet_id`         INT NOT NULL COMMENT 'punch location - outlets.outlet_id',
  `effective_from`    DATETIME NOT NULL COMMENT 'IST wall clock, inclusive',
  `effective_to`      DATETIME NULL COMMENT 'IST wall clock, exclusive - NULL = open',
  `note`              VARCHAR(255) NULL,
  `created_by`        INT NULL,
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`biomax_device_assignment_id`),
  KEY `idx_bda_device_from` (`biomax_device_id`, `effective_from`),
  KEY `idx_bda_outlet` (`outlet_id`),
  CONSTRAINT `fk_bda_device` FOREIGN KEY (`biomax_device_id`) REFERENCES `biomax_device` (`biomax_device_id`),
  CONSTRAINT `fk_bda_outlet` FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`),
  CONSTRAINT `chk_bda_range` CHECK (`effective_to` IS NULL OR `effective_to` > `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only history of every administrative change to a device: who did
-- what, when, with the before/after values. This is what the "View Device
-- History" screen reads, and it is the audit trail for a Cloud ID correction.
CREATE TABLE IF NOT EXISTS `biomax_device_event` (
  `biomax_device_event_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `biomax_device_id`  INT NOT NULL,
  `event_type`        ENUM('created','label_changed','notes_changed','dev_id_corrected',
                           'assignment_opened','assignment_closed','assignment_corrected') NOT NULL,
  `detail_json`       JSON NULL COMMENT 'before/after values and the reason - never punch data',
  `actor_employee_id` INT NULL COMMENT 'NULL = migration seed',
  `created_at`        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`biomax_device_event_id`),
  KEY `idx_bde_device_time` (`biomax_device_id`, `created_at`),
  CONSTRAINT `fk_bde_device` FOREIGN KEY (`biomax_device_id`) REFERENCES `biomax_device` (`biomax_device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================ 2. punches ===
-- RAW AND APPEND-ONLY (R8). One row per genuine punch, exactly as received.
-- The only UPDATE ever issued against this table is the retransmission
-- counter on the unique key below (R2). No column here depends on any other
-- table: dev_id is free text (R7), user_id is the device's string verbatim
-- (R5). Anything derived lives in biomax_punch_derived.
CREATE TABLE IF NOT EXISTS `biomax_punch` (
  `biomax_punch_id`   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- identity as sent by the device
  `dev_id`            VARCHAR(32) NOT NULL COMMENT 'header dev_id, verbatim - free text, NOT an FK (R7)',
  `user_id`           VARCHAR(32) NOT NULL COMMENT 'JSON user_id, verbatim. TEXT on purpose - equals the employee code',
  `io_time_raw`       CHAR(14)    NOT NULL COMMENT 'JSON io_time, verbatim, YYYYMMDDHHMMSS, device-local IST',

  -- the same instant as a DATETIME, converted once in SQL by STR_TO_DATE and
  -- never through a JS Date (R3). IST wall clock. Not UTC.
  `io_time`           DATETIME    NOT NULL COMMENT 'IST wall clock = STR_TO_DATE(io_time_raw). Not UTC.',
  `punch_date`        DATE GENERATED ALWAYS AS (DATE(`io_time`)) STORED
                      COMMENT 'calendar date in IST, for audit. NOT the attendance date - that is derived',

  -- other protocol fields, retained for audit
  `verify_mode`       BIGINT NULL COMMENT '0x40000000 = face',
  `io_mode`           BIGINT NULL COMMENT 'observed 0x01000000. NOT a direction flag',
  `fk_bin_data_lib`   VARCHAR(40) NULL,
  `log_image_present` TINYINT(1) NOT NULL DEFAULT 0,
  `cmd_id`            VARCHAR(40) NULL COMMENT 'header, e.g. RTLogSendAction',
  `blk_no`            INT NULL,
  `blk_len`           INT NULL,
  `content_length`    INT NULL,
  `body_len_prefix`   INT UNSIGNED NULL COMMENT 'uint32 LE prefix as sent',
  `raw_json`          TEXT NOT NULL COMMENT 'the JSON object bytes exactly as received',

  -- transport
  `source_ip`         VARCHAR(45) NULL,
  `source_port`       INT NULL,
  `received_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `retransmit_count`  INT NOT NULL DEFAULT 0 COMMENT 'identical frames received after the first (lost ACKs)',
  `last_retransmit_at` DATETIME(3) NULL,

  PRIMARY KEY (`biomax_punch_id`),
  -- Transport-level retransmission dedup ONLY (R2). Never collapses two
  -- different io_time values.
  UNIQUE KEY `uq_biomax_punch_retransmit` (`dev_id`, `user_id`, `io_time_raw`),
  KEY `idx_biomax_punch_date_dev` (`punch_date`, `dev_id`),
  KEY `idx_biomax_punch_user_time` (`user_id`, `io_time`),
  KEY `idx_biomax_punch_received` (`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Everything derived from CURRENT-STATE tables at the moment of ingest
-- (R16). Written by the receiver in the same transaction as the raw row;
-- rewritten ONLY by an audited re-derivation run, which then stamps
-- derivation_run_id. NEVER touched by an edit to an employee, a shift, a
-- schedule row or a device: those affect punches ingested afterwards.
--
-- attendance_date is NULL when it could not be derived at ingest;
-- derivation_status says why, and such punches sit in the review queue
-- instead of on the Attendance List (A3). No FK to new_employee or to
-- work_shift_weekly_schedule: the snapshot must survive later changes to
-- those rows.
CREATE TABLE IF NOT EXISTS `biomax_punch_derived` (
  `biomax_punch_id`   BIGINT UNSIGNED NOT NULL,
  `attendance_date`   DATE NULL COMMENT 'NULL = not derivable at ingest - see derivation_status',
  `derivation_status` ENUM('OK','UNMATCHED','NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF') NOT NULL,
  -- identity and posting as they stood at ingest
  `employee_id`       INT NULL COMMENT 'matched new_employee.employee_id at ingest - NULL = unmatched (R5: never 0)',
  `home_outlet_id`    INT NULL COMMENT 'new_employee.store_id at ingest',
  `department_id`     INT NULL COMMENT 'new_employee.department_id at ingest',
  -- the Shift Management data consulted for the date (R18), snapshotted
  `work_shift_id`     INT NULL COMMENT 'new_employee.default_work_shift_id at ingest',
  `work_shift_weekly_schedule_id` INT NULL COMMENT 'the PREVIOUS calendar day''s schedule row read at ingest, if any',
  `cutoff_applied`    TIME NULL COMMENT 'that row''s attendance_day_cutoff at ingest - NULL on a rest day or when not derivable',
  `derived_at`        DATETIME(3) NOT NULL,
  `derivation_run_id` BIGINT UNSIGNED NULL COMMENT 'NULL = written by ingest - else biomax_derivation_run',
  PRIMARY KEY (`biomax_punch_id`),
  KEY `idx_bpd_emp_date` (`employee_id`, `attendance_date`),
  KEY `idx_bpd_date` (`attendance_date`),
  KEY `idx_bpd_status` (`derivation_status`),
  CONSTRAINT `fk_bpd_punch` FOREIGN KEY (`biomax_punch_id`) REFERENCES `biomax_punch` (`biomax_punch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ======================================================= 3. raw captures ===
-- Anything the receiver could not turn into a punch row, plus the events an
-- operator needs to see: unparseable body, unknown request_code, oversized
-- frame, first sighting of an unregistered device, a flood cap, a shift
-- configuration error. Verbatim bytes where there are any, so a frame can be
-- re-parsed later. Successful polls are NOT logged here (they are ~3/min per
-- device); they go to stdout only.
CREATE TABLE IF NOT EXISTS `biomax_raw_request` (
  `biomax_raw_request_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `received_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `source_ip`         VARCHAR(45) NULL,
  `dev_id`            VARCHAR(32) NULL,
  `request_code`      VARCHAR(40) NULL,
  `outcome`           ENUM('unparsed','unknown_request_code','oversized',
                           'unregistered_device_first_seen','flood_capped',
                           'config_error','store_error') NOT NULL,
  `reason`            VARCHAR(255) NULL,
  `byte_length`       INT NOT NULL DEFAULT 0,
  `raw_frame`         BLOB NULL COMMENT 'headers + body, first 65535 bytes',
  PRIMARY KEY (`biomax_raw_request_id`),
  KEY `idx_biomax_raw_request_time` (`received_at`),
  KEY `idx_biomax_raw_request_dev` (`dev_id`, `received_at`),
  KEY `idx_biomax_raw_request_outcome` (`outcome`, `received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================= 4. audited re-derivation (reserved) ====
-- The ONLY path by which a stored derived value may change. Part 1 ships the
-- tables and the permission key so nothing structural is missing later; the
-- endpoint and screen are NOT built in Part 1. Contract: preview first,
-- range-limited, writes only biomax_punch_derived, never biomax_punch.
CREATE TABLE IF NOT EXISTS `biomax_derivation_run` (
  `biomax_derivation_run_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `run_type`          ENUM('preview','apply') NOT NULL,
  `scope`             ENUM('attendance_date','identity','posting','all') NOT NULL,
  `range_from`        DATE NOT NULL,
  `range_to`          DATE NOT NULL COMMENT 'inclusive - range_to - range_from <= 31 days',
  `preview_run_id`    BIGINT UNSIGNED NULL COMMENT 'an apply must reference the preview it was shown',
  `reason`            VARCHAR(255) NOT NULL,
  `requested_by`      INT NOT NULL COMMENT 'new_employee.employee_id',
  `punches_scanned`   INT NOT NULL DEFAULT 0,
  `punches_changed`   INT NOT NULL DEFAULT 0,
  `diff_summary`      JSON NULL COMMENT 'counts by (old_value,new_value) - never raw rows',
  `started_at`        DATETIME(3) NOT NULL,
  `finished_at`       DATETIME(3) NULL,
  `status`            ENUM('running','done','failed') NOT NULL,
  PRIMARY KEY (`biomax_derivation_run_id`),
  KEY `idx_bdr_time` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Before-image of every derived row a run changed, so a run can be reversed.
CREATE TABLE IF NOT EXISTS `biomax_derivation_change` (
  `biomax_derivation_run_id` BIGINT UNSIGNED NOT NULL,
  `biomax_punch_id`          BIGINT UNSIGNED NOT NULL,
  `old_attendance_date`   DATE NULL, `new_attendance_date`   DATE NULL,
  `old_derivation_status` VARCHAR(20) NULL, `new_derivation_status` VARCHAR(20) NULL,
  `old_employee_id`       INT NULL,  `new_employee_id`       INT NULL,
  `old_home_outlet_id`    INT NULL,  `new_home_outlet_id`    INT NULL,
  `old_department_id`     INT NULL,  `new_department_id`     INT NULL,
  PRIMARY KEY (`biomax_derivation_run_id`, `biomax_punch_id`),
  CONSTRAINT `fk_bdc_run` FOREIGN KEY (`biomax_derivation_run_id`) REFERENCES `biomax_derivation_run` (`biomax_derivation_run_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ======================================================== 5. permissions ===
-- Declared in all_permissions; granted by designation NAME exactly as
-- 20260910160000-work-shift-permissions does. Administrators (user_type 2)
-- need no grant because the permission middleware bypasses the table.
--
--   view_raw_attendance          open the Attendance List           HR EXECUTIVE
--   export_raw_attendance        its CSV export                     HR EXECUTIVE
--   view_attendance_punch_audit  the Punch Audit tab and its CSV    HR EXECUTIVE
--   view_biomax_devices          read the device registry           ADMIN ONLY (no grant)
--   manage_biomax_devices        add/move/replace/deactivate        ADMIN ONLY (no grant)
--   rederive_attendance          reserved; no route in Part 1       NOBODY
--
-- `all_permissions` has no unique key on permission_key, so each insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_raw_attendance' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_raw_attendance');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'export_raw_attendance' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'export_raw_attendance');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_attendance_punch_audit' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_attendance_punch_audit');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_biomax_devices' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_biomax_devices');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_biomax_devices' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_biomax_devices');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'rederive_attendance' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'rederive_attendance');

-- Grants: the three attendance READ keys to HR EXECUTIVE and nobody else.
-- Named by designation_name (case- and whitespace-insensitive) rather than a
-- literal id; if no such designation exists nothing is granted, and an
-- administrator grants it on the designation permissions screen. Each insert
-- is guarded on (permission_key, designation_id) because `permissions` has no
-- unique key either. Device management and re-derivation receive NO grant.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'view_raw_attendance' AS `permission_key`
           UNION ALL SELECT 'export_raw_attendance'
           UNION ALL SELECT 'view_attendance_punch_audit' ) k
    JOIN ( SELECT `designation_id` FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE' ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );

-- ======================================================= 6. device seed ====
-- The seven terminals confirmed by the business on 2026-09-10, Cloud IDs
-- VERBATIM (mixed letter O / digit 0 is intentional and must not be
-- "corrected"). Initial Effective From 2026-09-01 00:00:00 IST applies to
-- THESE seven rows only; it is not a default for any device registered
-- later (the UI asks for the date every time).
--
-- WH and G2 are two separate terminals at the same Warehouse location,
-- outlet_id 2 (constants/outlets.js WAREHOUSE_OUTLET_ID, confirmed by the
-- business). DN1..DN5 are resolved by outlet_code from the outlet master;
-- a device whose outlet cannot be found gets its device row but NO
-- assignment, and the final SELECT below reports it so it can be assigned
-- from the Devices screen rather than guessed here.
INSERT INTO `biomax_device` (`dev_id`, `label`, `notes`)
  SELECT * FROM (
    SELECT 'C26924B2E7351O35' AS `dev_id`, 'DN1' AS `label`, 'Seeded 2026-09-11' AS `notes`
    UNION ALL SELECT 'C2695C935328OB31', 'DN2', 'Seeded 2026-09-11'
    UNION ALL SELECT 'C2695C9353290F31', 'DN3', 'Seeded 2026-09-11'
    UNION ALL SELECT 'C26044C84F1A1D31', 'DN4', 'Seeded 2026-09-11'
    UNION ALL SELECT 'AMDB24121401205',  'DN5', 'Seeded 2026-09-11'
    UNION ALL SELECT 'C2695C56D30E1430', 'WH',  'Warehouse terminal 1. Seeded 2026-09-11'
    UNION ALL SELECT 'AMDB24121401307',  'G2',  'Warehouse terminal 2. Seeded 2026-09-11'
  ) seed
  WHERE NOT EXISTS (SELECT 1 FROM `biomax_device` b WHERE b.`dev_id` = seed.`dev_id`);

-- Outlet-coded devices: assignment only where the outlet exists.
INSERT INTO `biomax_device_assignment` (`biomax_device_id`, `outlet_id`, `effective_from`, `effective_to`, `note`)
  SELECT b.`biomax_device_id`, o.`outlet_id`, '2026-09-01 00:00:00', NULL, 'Initial assignment (seed)'
    FROM ( SELECT 'C26924B2E7351O35' AS `dev_id`, 'DN1' AS `outlet_code`
           UNION ALL SELECT 'C2695C935328OB31', 'DN2'
           UNION ALL SELECT 'C2695C9353290F31', 'DN3'
           UNION ALL SELECT 'C26044C84F1A1D31', 'DN4'
           UNION ALL SELECT 'AMDB24121401205',  'DN5' ) seed
    JOIN `biomax_device` b ON b.`dev_id` = seed.`dev_id`
    JOIN `outlets` o ON UPPER(TRIM(o.`outlet_code`)) = seed.`outlet_code`
   WHERE NOT EXISTS (
     SELECT 1 FROM `biomax_device_assignment` a WHERE a.`biomax_device_id` = b.`biomax_device_id` );

-- Warehouse devices: outlet_id 2, confirmed. Guarded on the outlet existing
-- so a restored copy without it does not violate the foreign key.
INSERT INTO `biomax_device_assignment` (`biomax_device_id`, `outlet_id`, `effective_from`, `effective_to`, `note`)
  SELECT b.`biomax_device_id`, o.`outlet_id`, '2026-09-01 00:00:00', NULL, 'Initial assignment (seed)'
    FROM `biomax_device` b
    JOIN `outlets` o ON o.`outlet_id` = 2
   WHERE b.`dev_id` IN ('C2695C56D30E1430', 'AMDB24121401307')
     AND NOT EXISTS (
       SELECT 1 FROM `biomax_device_assignment` a WHERE a.`biomax_device_id` = b.`biomax_device_id` );

-- The history rows for the seed, so the Devices screen shows where each
-- record came from.
INSERT INTO `biomax_device_event` (`biomax_device_id`, `event_type`, `detail_json`, `actor_employee_id`)
  SELECT b.`biomax_device_id`, 'created',
         JSON_OBJECT('label', b.`label`, 'source', 'migration 20260911120000'), NULL
    FROM `biomax_device` b
   WHERE b.`notes` LIKE '%Seeded 2026-09-11%'
     AND NOT EXISTS (
       SELECT 1 FROM `biomax_device_event` e
        WHERE e.`biomax_device_id` = b.`biomax_device_id` AND e.`event_type` = 'created' );
INSERT INTO `biomax_device_event` (`biomax_device_id`, `event_type`, `detail_json`, `actor_employee_id`)
  SELECT a.`biomax_device_id`, 'assignment_opened',
         JSON_OBJECT('outlet_id', a.`outlet_id`, 'effective_from', '2026-09-01 00:00:00', 'source', 'migration 20260911120000'), NULL
    FROM `biomax_device_assignment` a
   WHERE a.`note` = 'Initial assignment (seed)'
     AND NOT EXISTS (
       SELECT 1 FROM `biomax_device_event` e
        WHERE e.`biomax_device_id` = a.`biomax_device_id` AND e.`event_type` = 'assignment_opened' );

-- =========================================================== 7. reports ====
-- REPORT ONLY - these SELECTs change nothing. db-migrate prints result sets,
-- so whoever runs the deploy sees them.
--
-- (a) Seeded devices that could not be assigned because their outlet code
--     was not found. Assign them from the Devices screen.
SELECT b.`dev_id`, b.`label` AS `UNASSIGNED_SEEDED_DEVICE_assign_from_Devices_screen`
  FROM `biomax_device` b
  LEFT JOIN `biomax_device_assignment` a ON a.`biomax_device_id` = b.`biomax_device_id`
 WHERE a.`biomax_device_assignment_id` IS NULL;

-- (b) Working schedule rows saved before Attendance Day Cutoff became
--     mandatory (A1). NOT backfilled: a value here is HR's decision, made on
--     the Weekly Schedule tab. Until set, punches governed by such a row are
--     held in the review queue as MISSING_CUTOFF.
SELECT ws.`shift_code`, s.`day_of_week` AS `WORKING_ROW_WITHOUT_CUTOFF_set_in_Shift_Management`
  FROM `work_shift_weekly_schedule` s
  JOIN `work_shift` ws ON ws.`work_shift_id` = s.`work_shift_id`
 WHERE s.`is_working_day` = 1 AND s.`attendance_day_cutoff` IS NULL
 ORDER BY ws.`shift_code`, s.`day_of_week`;
