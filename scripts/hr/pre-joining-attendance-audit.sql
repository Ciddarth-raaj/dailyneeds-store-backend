-- =====================================================================
-- READ-ONLY audit: attendance and payroll rows BEFORE the joining date
--
--   mysql --host=<host> --user=<readonly-user> --password <database> \
--         --table < scripts/hr/pre-joining-attendance-audit.sql
--
-- STRICTLY READ-ONLY. Every statement is a SELECT: no UPDATE, DELETE, INSERT,
-- ALTER, CREATE or SET. Run it with an account that holds SELECT only.
--
-- WHAT IT ANSWERS. Before the joining-date boundary was enforced everywhere,
-- Process Attendance (calculateMonth persist) stored a NO_SHIFT_FOR_DATE row
-- for every date of the month before somebody joined - e.g. employee 2284,
-- joined 09-09-2026, got rows for 01-09..08-09 - and the monthly summary was
-- left HELD (is_final = 0) on those dates. This lists what exists, so the
-- clean-up can be reviewed BEFORE it happens.
--
-- HOW IT IS CLEANED UP - NOT BY THIS FILE. Once the fix is deployed, running
-- Process Attendance (or Recalculate) for the affected employee/month removes
-- the pre-joining rows inside the normal payroll-locked transaction and
-- re-derives the summary from 9 Sep onward. A payroll-LOCKED month is refused,
-- exactly as for any other attendance change; section 3 names those.
--
-- The joining date is parsed with utils/joining_date.js#JOINED_ON, verbatim.
-- =====================================================================

-- ====================== 1. stored day rows dated before the joining date ==
SELECT c.employee_id,
       ne.employee_name,
       DATE_FORMAT((
         CASE
         WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
         WHEN ne.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
         THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
         ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
         END
       ), '%Y-%m-%d') AS joined_on,
       COUNT(*) AS pre_joining_rows,
       MIN(DATE_FORMAT(c.attendance_date, '%Y-%m-%d')) AS first_date,
       MAX(DATE_FORMAT(c.attendance_date, '%Y-%m-%d')) AS last_date,
       GROUP_CONCAT(DISTINCT c.status ORDER BY c.status) AS statuses
  FROM attendance_day_calculation c
  JOIN new_employee ne ON ne.employee_id = c.employee_id
 WHERE c.attendance_date < (
         CASE
         WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
         WHEN ne.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
         THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
         ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
         END
       )
 GROUP BY c.employee_id, ne.employee_name, joined_on
 ORDER BY c.employee_id;

-- ======== 2. monthly summaries held ONLY by pre-joining dates (the ones ==
-- ========    that needed a manual closure)                               ==
SELECT m.employee_id, m.period_year, m.period_month, m.is_final,
       m.available_from, m.held_dates
  FROM attendance_monthly_payroll m
  JOIN new_employee ne ON ne.employee_id = m.employee_id
 WHERE m.is_final = 0
   AND m.available_from IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM attendance_day_calculation c
          WHERE c.employee_id = m.employee_id
            AND c.attendance_date < m.available_from
            AND YEAR(c.attendance_date) = m.period_year
            AND MONTH(c.attendance_date) = m.period_month)
 ORDER BY m.period_year, m.period_month, m.employee_id;

-- ======================== 3. of those employee/months, which are LOCKED ==
SELECT p.employee_id, p.period_year, p.period_month, p.status
  FROM payrun_employee_calculation p
  JOIN new_employee ne ON ne.employee_id = p.employee_id
 WHERE p.status = 'APPROVED_LOCKED'
   AND EXISTS (
         SELECT 1 FROM attendance_day_calculation c
          WHERE c.employee_id = p.employee_id
            AND YEAR(c.attendance_date) = p.period_year
            AND MONTH(c.attendance_date) = p.period_month
            AND c.attendance_date < (
         CASE
         WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
         WHEN ne.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
         THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
         ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
         END
            ))
 ORDER BY p.period_year, p.period_month, p.employee_id;

-- =================== 4. shift history rows effective before joining =====
-- Harmless once the fix is deployed (no pre-joining date reads a shift),
-- listed so the roster can be tidied by a dated correction if wanted.
SELECT a.employee_id, a.employee_work_shift_assignment_id, a.work_shift_id,
       DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from, a.source,
       DATE_FORMAT((
         CASE
         WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
         WHEN ne.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
         THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
         ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
         END
       ), '%Y-%m-%d') AS joined_on
  FROM employee_work_shift_assignment a
  JOIN new_employee ne ON ne.employee_id = a.employee_id
 WHERE a.effective_from < (
         CASE
         WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
         WHEN ne.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
         THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
         ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
         END
       )
 ORDER BY a.employee_id, a.effective_from;
