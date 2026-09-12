-- Attendance v2 / A0 - the employee -> work shift assignment HISTORY.
--
-- ADDITIVE ONLY. One new table, one backfill of it, and nothing else. No
-- existing column is altered, no existing row is rewritten, no permission is
-- revoked. `new_employee.default_work_shift_id` keeps its present meaning and
-- keeps being the column the assignment screen and the Biomax receiver read;
-- this table sits beside it and answers a question that column cannot.
--
-- THE QUESTION. `default_work_shift_id` is CURRENT state: it says which shift
-- an employee is on today. Attendance for 3rd August needs the shift they were
-- on ON 3rd AUGUST. Reading the current column for a historical date means a
-- roster change in September silently rewrites August's worked minutes, its
-- shortage and its overtime - and therefore a payslip that has already been
-- paid. An effective-dated, append-only history is what makes a past date
-- stop moving.
--
-- APPEND-ONLY, AND THAT IS THE POINT. Rows are INSERTed and never UPDATEd or
-- DELETEd. A mistake is corrected by appending a further row, not by editing
-- the wrong one, so the record of what payroll actually believed on the day it
-- ran survives the correction. There is deliberately NO unique key on
-- (employee_id, effective_from): a correction dated to the same day as the row
-- it corrects has to be insertable, and the resolver breaks the tie on
-- assignment id, newest wins.
--
-- THE RESOLVER RULE, in one sentence, implemented in utils/shiftResolution.js:
--
--     the row with the greatest effective_from <= attendance_date,
--     and among those the greatest assignment id.
--
-- A date EARLIER than an employee's first row resolves to NO ASSIGNMENT. It
-- does not fall back to `default_work_shift_id`, and it does not guess. That
-- is the cutover boundary, and it is stated rather than hidden - see the
-- backfill note below.

CREATE TABLE IF NOT EXISTS `employee_work_shift_assignment` (
  `employee_work_shift_assignment_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`    INT  NOT NULL COMMENT 'new_employee.employee_id',
  `work_shift_id`  INT  NOT NULL COMMENT 'work_shift.work_shift_id - the NEW master, never shift_master',
  `effective_from` DATE NOT NULL COMMENT 'inclusive attendance date from which this assignment applies',
  `source`         ENUM('MIGRATION_BACKFILL','ASSIGNMENT','BULK_ASSIGNMENT','CORRECTION') NOT NULL,
  `note`           VARCHAR(255) NULL,
  `created_by`     INT NULL COMMENT 'new_employee.employee_id of the actor - NULL = this migration',
  `created_at`     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`employee_work_shift_assignment_id`),
  -- The resolver's index: it reads one employee, ordered by effective_from
  -- descending, and stops at the first row. No unique key - see the header.
  KEY `idx_ewsa_employee_effective` (`employee_id`, `effective_from`),
  KEY `idx_ewsa_work_shift` (`work_shift_id`),
  CONSTRAINT `fk_ewsa_work_shift`
    FOREIGN KEY (`work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================================================== the backfill, and =====
-- ======================================== exactly how far back it claims =====
--
-- One row per employee who ALREADY has a `default_work_shift_id`, dated
-- 2026-09-01 - the Attendance v2 cutover, which is the same date the Biomax
-- device assignments were seeded with and the earliest date any punch in this
-- system can belong to. From that date onward, every employee who is assigned
-- today resolves correctly.
--
-- WHAT IS NOT BACKFILLED, AND WHY NOT. No history is invented before
-- 2026-09-01. Nothing in the database records which shift anyone was on in
-- July, so any earlier row would be a payroll-affecting guess made by a
-- migration - the one place it could never be reviewed. A date before the
-- cutover therefore resolves to NO ASSIGNMENT and the engine reports
-- NO_SHIFT_FOR_DATE rather than a number. Pre-cutover attendance is not a
-- v2 concern; there are no v2 punches there.
--
-- Employees with NULL `default_work_shift_id` get no row at all, because
-- "unassigned" is a real answer and must stay distinguishable from "assigned
-- to something we had to guess".
--
-- Re-runnable: the guard is per employee, so a second run inserts nothing.
INSERT INTO `employee_work_shift_assignment`
       (`employee_id`, `work_shift_id`, `effective_from`, `source`, `note`, `created_by`)
  SELECT ne.`employee_id`, ne.`default_work_shift_id`, '2026-09-01', 'MIGRATION_BACKFILL',
         'Attendance v2 cutover: current default work shift, effective from the cutover date only', NULL
    FROM `new_employee` ne
   WHERE ne.`default_work_shift_id` IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM `employee_work_shift_assignment` a
        WHERE a.`employee_id` = ne.`employee_id` );

-- ============================================================== reports =====
-- REPORT ONLY. db-migrate prints result sets, so whoever runs the deploy sees
-- how many employees now have dated history and how many are still unassigned
-- and will resolve to NO_SHIFT_FOR_DATE until HR assigns them.
SELECT COUNT(*) AS `EMPLOYEES_WITH_DATED_SHIFT_HISTORY`
  FROM ( SELECT DISTINCT `employee_id` FROM `employee_work_shift_assignment` ) x;

SELECT COUNT(*) AS `ACTIVE_EMPLOYEES_STILL_UNASSIGNED_assign_on_Shift_Assignment_screen`
  FROM `new_employee`
 WHERE `status` = 1 AND `default_work_shift_id` IS NULL;

-- ================= the WORK SHIFT CONFIGURATION history (review fix #2) =====
--
-- A0 dated the employee -> shift ASSIGNMENT, which stopped a roster change in
-- October from rewriting September. It did not date the SHIFT ITSELF, and that
-- left the identical hole one level down: editing a work shift's break, its
-- attendance-day cutoff or its OT rules changed `work_shift` and
-- `work_shift_weekly_schedule` IN PLACE, and the next recalculation of a
-- settled September date read October's configuration. A payslip that had
-- already been paid could move because somebody corrected a shift.
--
-- This table closes it. Each row is an append-only, effective-dated snapshot
-- of the WHOLE definition of one shift - the master row's attendance/OT
-- columns plus all seven weekly-schedule rows - as one JSON document.
-- Attendance for a date resolves BOTH the dated assignment (which shift) and
-- the version in force on that date (which version of it).
--
-- THE LIVE TABLES ARE UNTOUCHED AND KEEP THEIR MEANING. Saving a Work Shift
-- writes `work_shift` and `work_shift_weekly_schedule` exactly as it always
-- has - the screen, the endpoint, the response and every existing reader are
-- unchanged - and additionally APPENDS a version here when the content really
-- changed. No prior version is ever updated or deleted.
--
-- NO UNIQUE KEY ON (work_shift_id, effective_from), for the same reason A0 has
-- none: two saves on one day must both be insertable, and the resolver breaks
-- the tie on id, newest wins.
--
-- `config_hash` is written by the application, and is NULL on the rows this
-- migration seeds: a JSON document serialized by MySQL need not be byte-
-- identical to one serialized by Node, so the application recomputes the hash
-- from the DOCUMENT when it needs to know whether anything changed, and the
-- column is an audit convenience rather than the comparison itself.
CREATE TABLE IF NOT EXISTS `work_shift_config_version` (
  `work_shift_config_version_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `work_shift_id`   INT  NOT NULL,
  `effective_from`  DATE NOT NULL COMMENT 'inclusive attendance date from which this configuration applies',
  `config_hash`     CHAR(32) NULL COMMENT 'application fingerprint of config_document. NULL on the migration seed',
  `config_document` JSON NOT NULL COMMENT 'the whole shift definition: master OT/attendance columns + all seven weekly rows',
  `source`          ENUM('MIGRATION_SEED','WORK_SHIFT_SAVE','CORRECTION') NOT NULL,
  `note`            VARCHAR(255) NULL,
  `created_by`      INT NULL COMMENT 'new_employee.employee_id of the actor - NULL = this migration',
  `created_at`      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`work_shift_config_version_id`),
  KEY `idx_wscv_shift_effective` (`work_shift_id`, `effective_from`),
  CONSTRAINT `fk_wscv_work_shift`
    FOREIGN KEY (`work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------- the seed ----
-- One version per EXISTING work shift, capturing its configuration exactly as
-- it stands at this deploy, effective from the Attendance v2 cutover
-- (2026-09-01) - the same cutover the assignment history uses and the earliest
-- date any punch in this system can belong to.
--
-- WITHOUT THIS SEED THE FIX WOULD NOT HOLD. A version appended by a later edit
-- is effective from the day of that edit; a September date resolving to "no
-- version yet" would fall back to the live tables and therefore read the NEW
-- configuration - which is the very bug. Seeding at the cutover means every
-- date v2 can calculate is covered by a dated version, and a later edit can
-- only ever apply from its own day forward.
--
-- The document is built here in SQL so that what is captured is the
-- configuration as it ACTUALLY IS, not as a later application run would
-- reconstruct it. Field names, order and normalization match
-- `utils/shift_config_version.js#buildConfigVersion`, which re-normalizes and
-- re-sorts anything it reads back, so neither key order nor row order matters.
--
-- Re-runnable: the guard is per shift, so a second run inserts nothing.
INSERT INTO `work_shift_config_version`
       (`work_shift_id`, `effective_from`, `config_hash`, `config_document`, `source`, `note`, `created_by`)
  SELECT ws.`work_shift_id`,
         '2026-09-01',
         NULL,
         JSON_OBJECT(
           'format', 1,
           'config', JSON_OBJECT(
             'shift_code', UPPER(ws.`shift_code`),
             'overtime_allowed', ws.`overtime_allowed`,
             'overtime_minimum_minutes', ws.`overtime_minimum_minutes`,
             'overtime_rounding_method', UPPER(ws.`overtime_rounding_method`),
             'overtime_rounding_interval_minutes', ws.`overtime_rounding_interval_minutes`,
             'overtime_minimum_threshold_only', ws.`overtime_minimum_threshold_only`,
             'maximum_ot_minutes_per_day', ws.`maximum_ot_minutes_per_day`,
             'pre_shift_overtime_allowed', ws.`pre_shift_overtime_allowed`,
             'pre_shift_overtime_minimum_minutes', ws.`pre_shift_overtime_minimum_minutes`,
             'pre_shift_overtime_rounding_method', UPPER(ws.`pre_shift_overtime_rounding_method`),
             'pre_shift_overtime_rounding_interval_minutes', ws.`pre_shift_overtime_rounding_interval_minutes`,
             'late_offset_against_overtime', ws.`late_offset_against_overtime`,
             'early_exit_offset_against_overtime', ws.`early_exit_offset_against_overtime`
           ),
           'schedule', COALESCE((
             SELECT JSON_ARRAYAGG(JSON_OBJECT(
                      'day_of_week', d.`day_of_week`,
                      'is_working_day', d.`is_working_day`,
                      'in_time', TIME_FORMAT(d.`in_time`, '%H:%i:%s'),
                      'out_time', TIME_FORMAT(d.`out_time`, '%H:%i:%s'),
                      'attendance_day_cutoff', TIME_FORMAT(d.`attendance_day_cutoff`, '%H:%i:%s'),
                      'break_minutes', d.`break_minutes`,
                      'ot_rate', d.`ot_rate`
                    ))
               FROM `work_shift_weekly_schedule` d
              WHERE d.`work_shift_id` = ws.`work_shift_id`
           ), JSON_ARRAY())
         ),
         'MIGRATION_SEED',
         'Attendance v2 cutover: the work shift configuration as it stood at deploy, effective from the cutover date only',
         NULL
    FROM `work_shift` ws
   WHERE NOT EXISTS (
     SELECT 1 FROM `work_shift_config_version` v
      WHERE v.`work_shift_id` = ws.`work_shift_id` );

-- ========================================================== permissions =====
-- `correct_employee_shift_assignment` - the AUTHORIZED CORRECTION path for a
-- shift assignment that genuinely needs a historical effective date.
--
-- The ordinary assignment route dates a change TODAY and has no field for any
-- other date, which is right: moving somebody to a new shift must not rewrite
-- yesterday's worked minutes. But the append-only resolver explicitly supports
-- a same-date correction, and a genuine historical mistake has to be fixable
-- by somebody. That is a separate service path with its own permission, its
-- own explicit `effective_from`, a mandatory audit note and `source =
-- 'CORRECTION'` - never a backdate smuggled through the normal route.
--
-- DECLARED AND GRANTED TO NOBODY. Correcting a past assignment changes
-- payroll-consumed history, so an administrator grants this deliberately on
-- the designation screen; until then it is administrators only, through the
-- user_type 2 bypass.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'correct_employee_shift_assignment' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'correct_employee_shift_assignment');

SELECT COUNT(*) AS `WORK_SHIFTS_WITH_A_SEEDED_CONFIGURATION_VERSION`
  FROM ( SELECT DISTINCT `work_shift_id` FROM `work_shift_config_version` ) v;
