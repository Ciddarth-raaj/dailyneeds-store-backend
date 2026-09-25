-- Attendance - DEVICE TIME CORRECTION.
--
-- ADDITIVE ONLY. Two new tables. No existing table is altered, no existing
-- row is rewritten, no permission key is declared or granted, and no row of
-- `biomax_punch` or `biomax_punch_derived` is touched - now or by the
-- application afterwards.
--
-- THE CASE. A terminal's clock was wrong for a period: people punched at the
-- right moment and the device stamped the wrong time. The raw punch is still
-- the evidence of what the DEVICE sent, byte for byte, and stays so. The
-- correction is a DECISION an administrator took, with a reason, and it lives
-- beside the evidence exactly as `attendance_punch_void` does.
--
-- THE EFFECTIVE TIME. Every read that calculates or shows attendance LEFT
-- JOINs the active correction row on `active_biomax_punch_id` and uses
-- COALESCE(corrected_io_time, biomax_punch.io_time). With no active
-- correction that is the raw time, unchanged.
--
-- ONE BATCH, MANY PUNCHES. `attendance_device_time_correction` is the batch:
-- the criteria the administrator entered (date, device, optional outlet,
-- window, offset, reason), who applied it and when, and - once reverted -
-- who reverted it, when and why. A batch is never deleted; revert flips its
-- status to REVERTED. `attendance_device_time_correction_punch` is one row
-- per corrected punch, snapshotting the original and the corrected time.
--
-- NO DOUBLE CORRECTION. `active_biomax_punch_id` is a stored generated column,
-- the punch id while the row is active and NULL once reverted, and it carries
-- a UNIQUE KEY: a raw punch can have at most ONE active correction, whichever
-- batch tries to add a second - the database refuses it, not only the code.
-- A reverted row keeps its punch and times for the audit and no longer
-- blocks a fresh correction. `batch_ref` (issued at Preview) is UNIQUE so the
-- same preview can be applied once.
--
-- ADMINISTRATORS ONLY, by `user_type = 2` on the token (see
-- `middlewares/admin_only.js`), and therefore NO permission key: a key could
-- be granted to a designation, and this must not be delegable.

CREATE TABLE IF NOT EXISTS `attendance_device_time_correction` (
  `attendance_device_time_correction_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_ref`               CHAR(36) NOT NULL COMMENT 'the correction batch ID issued at Preview - one preview, one apply',
  `correction_date`         DATE NOT NULL COMMENT 'the calendar date of the affected punches (biomax_punch.punch_date)',
  `biomax_device_id`        INT NOT NULL COMMENT 'the terminal whose clock was wrong',
  `dev_id`                  VARCHAR(32) NOT NULL COMMENT 'snapshot of biomax_device.dev_id - the punches matched on this',
  `device_label`            VARCHAR(100) NULL COMMENT 'snapshot of biomax_device.label',
  `outlet_id`               INT NULL COMMENT 'NULL = wherever the device was assigned, else only punches whose device was assigned HERE at the punch time',
  `window_from`             DATETIME NOT NULL COMMENT 'DEVICE clock, inclusive - compared with biomax_punch.io_time',
  `window_to`               DATETIME NOT NULL COMMENT 'DEVICE clock, inclusive - compared with biomax_punch.io_time',
  `offset_minutes`          INT NOT NULL COMMENT 'added to the device time: +150 turns 06:42:15 into 09:12:15',
  `reason_code`             VARCHAR(40) NOT NULL COMMENT 'e.g. BIOMAX_DEVICE_TIME_ERROR',
  `remarks`                 VARCHAR(500) NOT NULL COMMENT 'mandatory - how the offset was established',
  `preview_fingerprint`     CHAR(64) NOT NULL COMMENT 'sha256 of the previewed punch set - the apply re-read had to match it',
  `punch_count`             INT NOT NULL,
  `employee_count`          INT NOT NULL,
  `status`                  ENUM('APPLIED','REVERTED') NOT NULL DEFAULT 'APPLIED',
  `applied_by_employee_id`  INT NULL,
  `applied_by_user_id`      INT NULL,
  `applied_at`              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reverted_by_employee_id` INT NULL,
  `reverted_by_user_id`     INT NULL,
  `reverted_at`             TIMESTAMP(3) NULL,
  `revert_reason`           VARCHAR(500) NULL,
  PRIMARY KEY (`attendance_device_time_correction_id`),
  UNIQUE KEY `uq_adtc_batch_ref` (`batch_ref`),
  KEY `idx_adtc_date_device` (`correction_date`, `biomax_device_id`),
  KEY `idx_adtc_applied_at` (`applied_at`),
  CONSTRAINT `fk_adtc_device`
    FOREIGN KEY (`biomax_device_id`) REFERENCES `biomax_device` (`biomax_device_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_adtc_window` CHECK (`window_to` >= `window_from`),
  CONSTRAINT `chk_adtc_offset` CHECK (`offset_minutes` <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `attendance_device_time_correction_punch` (
  `attendance_device_time_correction_punch_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_device_time_correction_id` BIGINT UNSIGNED NOT NULL,
  `biomax_punch_id`         BIGINT UNSIGNED NOT NULL COMMENT 'the raw punch - biomax_punch.biomax_punch_id, untouched',
  `employee_id`             INT NULL COMMENT 'snapshot of biomax_punch_derived.employee_id - NULL for a punch matched to nobody',
  `original_io_time`        DATETIME NOT NULL COMMENT 'snapshot of biomax_punch.io_time (device clock, IST wall clock)',
  `corrected_io_time`       DATETIME NOT NULL COMMENT 'original_io_time + offset_minutes - the EFFECTIVE time while active',
  `offset_minutes`          INT NOT NULL,
  `is_active`               TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 once the batch is reverted - the row stays',
  `active_biomax_punch_id`  BIGINT UNSIGNED GENERATED ALWAYS AS
                              (CASE WHEN `is_active` = 1 THEN `biomax_punch_id` ELSE NULL END) STORED
                              COMMENT 'UNIQUE: at most one active correction per raw punch',
  PRIMARY KEY (`attendance_device_time_correction_punch_id`),
  UNIQUE KEY `uq_adtcp_batch_punch` (`attendance_device_time_correction_id`, `biomax_punch_id`),
  UNIQUE KEY `uq_adtcp_active_punch` (`active_biomax_punch_id`),
  KEY `idx_adtcp_punch` (`biomax_punch_id`),
  KEY `idx_adtcp_employee` (`employee_id`),
  CONSTRAINT `fk_adtcp_batch`
    FOREIGN KEY (`attendance_device_time_correction_id`)
    REFERENCES `attendance_device_time_correction` (`attendance_device_time_correction_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adtcp_punch`
    FOREIGN KEY (`biomax_punch_id`) REFERENCES `biomax_punch` (`biomax_punch_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
