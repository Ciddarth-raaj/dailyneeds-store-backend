-- Minimal schema for the Biomax receiver stress harness ONLY (never run
-- against a real database). The biomax_* tables mirror the production
-- migrations (20260911120000, 20260912120000, 20260913120000) in the columns
-- and keys the receiver touches; the three read-only lookup tables carry
-- just the columns biomax/store.js selects.
DROP TABLE IF EXISTS biomax_punch_derived, biomax_punch, biomax_raw_request, biomax_device,
  new_employee, employee_work_shift_assignment, work_shift_weekly_schedule;

CREATE TABLE biomax_device (
  biomax_device_id INT NOT NULL AUTO_INCREMENT,
  dev_id VARCHAR(32) NOT NULL,
  label VARCHAR(100) NOT NULL,
  first_seen_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NULL,
  last_punch_at DATETIME(3) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (biomax_device_id),
  UNIQUE KEY uq_biomax_device_dev_id (dev_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE biomax_punch (
  biomax_punch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dev_id VARCHAR(32) NULL,
  user_id VARCHAR(32) NOT NULL,
  io_time_raw CHAR(14) NOT NULL,
  io_time DATETIME NOT NULL,
  verify_mode BIGINT NULL, io_mode BIGINT NULL, fk_bin_data_lib VARCHAR(40) NULL,
  log_image_present TINYINT(1) NOT NULL DEFAULT 0,
  cmd_id VARCHAR(40) NULL, blk_no INT NULL, blk_len INT NULL, content_length INT NULL,
  body_len_prefix INT UNSIGNED NULL, raw_json TEXT NULL,
  source_ip VARCHAR(45) NULL, source_port INT NULL,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  retransmit_count INT NOT NULL DEFAULT 0,
  last_retransmit_at DATETIME(3) NULL,
  ingest_source ENUM('LIVE','HISTORICAL_PULL','DIGISME_IMPORT') NOT NULL DEFAULT 'LIVE',
  biomax_historical_pull_id BIGINT UNSIGNED NULL,
  import_batch_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (biomax_punch_id),
  UNIQUE KEY uq_biomax_punch_retransmit (dev_id, user_id, io_time_raw),
  KEY idx_biomax_punch_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE biomax_punch_derived (
  biomax_punch_id BIGINT UNSIGNED NOT NULL,
  attendance_date DATE NULL,
  derivation_status ENUM('OK','UNMATCHED','NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF') NOT NULL,
  employee_id INT NULL, home_outlet_id INT NULL, department_id INT NULL,
  work_shift_id INT NULL, work_shift_weekly_schedule_id INT NULL, cutoff_applied TIME NULL,
  derived_at DATETIME(3) NOT NULL, derivation_run_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (biomax_punch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE biomax_raw_request (
  biomax_raw_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  source_ip VARCHAR(45) NULL, dev_id VARCHAR(32) NULL, request_code VARCHAR(40) NULL,
  outcome ENUM('unparsed','unknown_request_code','oversized','unregistered_device_first_seen',
               'flood_capped','config_error','store_error') NOT NULL,
  reason VARCHAR(255) NULL,
  byte_length INT NOT NULL DEFAULT 0,
  raw_frame BLOB NULL,
  PRIMARY KEY (biomax_raw_request_id),
  KEY idx_biomax_raw_request_time (received_at),
  KEY idx_biomax_raw_request_dev (dev_id, received_at),
  KEY idx_biomax_raw_request_outcome (outcome, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE new_employee (
  employee_id INT NOT NULL, store_id INT NOT NULL, department_id INT NOT NULL,
  default_work_shift_id INT NULL, PRIMARY KEY (employee_id)
) ENGINE=InnoDB;
CREATE TABLE employee_work_shift_assignment (
  employee_work_shift_assignment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id INT NOT NULL, work_shift_id INT NOT NULL, effective_from DATE NOT NULL,
  PRIMARY KEY (employee_work_shift_assignment_id), KEY (employee_id, effective_from)
) ENGINE=InnoDB;
CREATE TABLE work_shift_weekly_schedule (
  work_shift_weekly_schedule_id INT AUTO_INCREMENT PRIMARY KEY,
  work_shift_id INT NOT NULL, day_of_week TINYINT NOT NULL,
  is_working_day TINYINT(1) NOT NULL DEFAULT 1, attendance_day_cutoff TIME NULL,
  UNIQUE KEY (work_shift_id, day_of_week)
) ENGINE=InnoDB;

INSERT INTO biomax_device (dev_id, label) VALUES
  ('C26924B2E7351O35','DN1'),('C2695C935328OB31','DN2'),('C2695C9353290F31','DN3'),
  ('C26044C84F1A1D31','DN4'),('AMDB24121401205','DN5'),('C2695C56D30E1430','WH'),('AMDB24121401307','G2');
INSERT INTO new_employee VALUES (1952, 2, 4, 7);
INSERT INTO employee_work_shift_assignment (employee_id, work_shift_id, effective_from) VALUES (1952, 7, '2026-09-01');
INSERT INTO work_shift_weekly_schedule (work_shift_id, day_of_week, is_working_day, attendance_day_cutoff)
  VALUES (7,0,1,'04:00:00'),(7,1,1,'04:00:00'),(7,2,1,'04:00:00'),(7,3,1,'04:00:00'),(7,4,1,'04:00:00'),(7,5,1,'04:00:00'),(7,6,1,'04:00:00');
