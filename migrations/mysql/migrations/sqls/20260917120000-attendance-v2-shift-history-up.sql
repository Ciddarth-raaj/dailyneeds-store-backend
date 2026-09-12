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
