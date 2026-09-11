-- Shift configuration verification - READ ONLY.
--
-- Run on the production host against the primary application database
-- (the db.mysql section of config.json, same connection as drivers/mysql.js):
--
--   mysql --table -u <user> -p <database> < scripts/hr/verify-shift-configuration.sql
--
-- Every statement is a SELECT. Nothing here writes to work_shift,
-- work_shift_weekly_schedule, new_employee, biomax_punch or
-- biomax_punch_derived, and section 6 is a dry run only: the stored
-- derivation rows are left exactly as they are (R16 - only an audited
-- re-derivation run may rewrite them).
--
-- Rules mirrored here, verbatim from the code:
--   R18 (biomax/attendanceDate.js): read the employee's default_work_shift_id,
--        then the schedule row for the PREVIOUS calendar day's weekday. Rest
--        row -> calendar date. Working row with time_of_day < cutoff ->
--        previous date, else calendar date. Working row without cutoff ->
--        MISSING_CUTOFF. No row -> NO_SCHEDULE_ROW. No shift -> NO_SHIFT.
--   A2  (utils/workShift.js validateCutoffsAgainstNextIn): a working row's
--        cutoff must be strictly earlier than the In time of the NEXT
--        working row (wrapping around the week), because it is a time on
--        the following morning.
--   "active employee" = new_employee.status = 1, the predicate the Employee
--        Work Shift screen uses (repository/employee_work_shift.js).

-- ===================================================== 1. employees ========
SELECT '1. ACTIVE EMPLOYEES: total / assigned / unassigned' AS section;

SELECT
  COUNT(*)                                                    AS active_employees,
  SUM(ne.default_work_shift_id IS NOT NULL)                   AS with_default_work_shift,
  SUM(ne.default_work_shift_id IS NULL)                       AS without_default_work_shift
FROM new_employee ne
WHERE ne.status = 1;

SELECT '1b. ACTIVE EMPLOYEES WITHOUT A DEFAULT WORK SHIFT' AS section;

SELECT ne.employee_id, ne.employee_name, ne.store_id, ne.department_id
FROM new_employee ne
WHERE ne.status = 1 AND ne.default_work_shift_id IS NULL
ORDER BY ne.employee_id;

-- ======================================================== 2. shifts ========
SELECT '2. WORK SHIFTS (all, with active-employee headcount)' AS section;

SELECT
  ws.work_shift_id,
  ws.shift_code,
  ws.shift_name,
  ws.active,
  COUNT(ne.employee_id)                                       AS active_employees_assigned,
  CASE
    WHEN ws.active = 1 AND COUNT(ne.employee_id) = 0 THEN 'FLAG: active shift with zero employees'
    WHEN ws.active = 0 AND COUNT(ne.employee_id) > 0 THEN 'FLAG: employees assigned to an INACTIVE shift'
    ELSE ''
  END                                                         AS flag
FROM work_shift ws
LEFT JOIN new_employee ne
  ON ne.default_work_shift_id = ws.work_shift_id AND ne.status = 1
GROUP BY ws.work_shift_id, ws.shift_code, ws.shift_name, ws.active
ORDER BY ws.active DESC, ws.shift_code;

SELECT '2b. ACTIVE EMPLOYEES ASSIGNED TO AN INACTIVE SHIFT' AS section;

SELECT ne.employee_id, ne.employee_name, ws.shift_code, ws.shift_name
FROM new_employee ne
JOIN work_shift ws ON ws.work_shift_id = ne.default_work_shift_id
WHERE ne.status = 1 AND ws.active = 0
ORDER BY ws.shift_code, ne.employee_id;

-- ============================================== 3. weekly schedules ========
SELECT '3. WEEKLY SCHEDULE ROWS OF EVERY ACTIVE SHIFT' AS section;

SELECT
  ws.shift_code,
  s.day_of_week,
  ELT(s.day_of_week + 1, 'Sun','Mon','Tue','Wed','Thu','Fri','Sat') AS weekday,
  IF(s.is_working_day = 1, 'working', 'rest')                 AS day_type,
  s.in_time,
  s.out_time,
  s.attendance_day_cutoff,
  CASE
    WHEN s.is_working_day = 1 AND (s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '')
      THEN 'FLAG: working row without cutoff (A1)'
    ELSE ''
  END                                                         AS flag
FROM work_shift ws
JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
WHERE ws.active = 1
ORDER BY ws.shift_code, s.day_of_week;

SELECT '3b. ACTIVE SHIFTS MISSING ANY OF THE 7 WEEKDAY ROWS (-> NO_SCHEDULE_ROW)' AS section;

SELECT ws.shift_code, COUNT(s.work_shift_weekly_schedule_id) AS rows_present,
       7 - COUNT(s.work_shift_weekly_schedule_id)           AS rows_missing
FROM work_shift ws
LEFT JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
WHERE ws.active = 1
GROUP BY ws.work_shift_id, ws.shift_code
HAVING COUNT(s.work_shift_weekly_schedule_id) <> 7;

SELECT '3c. COUNT OF WORKING ROWS WITH NULL/EMPTY CUTOFF (all active shifts)' AS section;

SELECT
  COUNT(*)                                                    AS working_rows_total,
  SUM(s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '') AS working_rows_without_cutoff
FROM work_shift ws
JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
WHERE ws.active = 1 AND s.is_working_day = 1;

-- ============================================ 4. midnight crossing ========
SELECT '4. MIDNIGHT-CROSSING WORKING ROWS (out_time < in_time) AND THEIR CUTOFF' AS section;

SELECT
  ws.shift_code,
  ELT(s.day_of_week + 1, 'Sun','Mon','Tue','Wed','Thu','Fri','Sat') AS weekday,
  s.in_time, s.out_time, s.attendance_day_cutoff,
  IF(s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '',
     'FLAG: crosses midnight with NO cutoff - workday will split across two dates', 'ok') AS flag
FROM work_shift ws
JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
WHERE ws.active = 1 AND s.is_working_day = 1
  AND s.in_time IS NOT NULL AND s.out_time IS NOT NULL
  AND s.out_time < s.in_time
ORDER BY ws.shift_code, s.day_of_week;

SELECT '4b. PER-SHIFT SUMMARY: crosses midnight? all crossing rows have cutoff?' AS section;

SELECT
  ws.shift_code,
  SUM(s.is_working_day = 1 AND s.out_time < s.in_time)                       AS midnight_crossing_rows,
  SUM(s.is_working_day = 1 AND s.out_time < s.in_time
      AND (s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '')) AS crossing_rows_without_cutoff,
  SUM(s.is_working_day = 1 AND (s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '')) AS any_working_rows_without_cutoff
FROM work_shift ws
JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
WHERE ws.active = 1
GROUP BY ws.work_shift_id, ws.shift_code
ORDER BY ws.shift_code;

-- ======================================================= 5. rule A2 ========
SELECT '5. RULE A2: cutoff must be EARLIER than the next working day''s In time' AS section;

SELECT
  ws.shift_code,
  ELT(s.day_of_week + 1, 'Sun','Mon','Tue','Wed','Thu','Fri','Sat')   AS weekday,
  s.attendance_day_cutoff,
  ELT(n.day_of_week + 1, 'Sun','Mon','Tue','Wed','Thu','Fri','Sat')   AS next_working_day,
  n.in_time                                                           AS next_in_time,
  IF(s.attendance_day_cutoff >= n.in_time, 'VIOLATES A2', 'ok')       AS a2
FROM work_shift ws
JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
JOIN work_shift_weekly_schedule n ON n.work_shift_id = ws.work_shift_id
  AND n.is_working_day = 1 AND n.in_time IS NOT NULL
  -- the nearest working day strictly after s, wrapping around the week
  AND ((n.day_of_week - s.day_of_week + 7) % 7) = (
        SELECT MIN((c.day_of_week - s.day_of_week + 7) % 7)
        FROM work_shift_weekly_schedule c
        WHERE c.work_shift_id = ws.work_shift_id AND c.is_working_day = 1
          AND c.in_time IS NOT NULL AND c.day_of_week <> s.day_of_week)
WHERE ws.active = 1 AND s.is_working_day = 1
  AND s.attendance_day_cutoff IS NOT NULL AND s.attendance_day_cutoff <> ''
ORDER BY a2 DESC, ws.shift_code, s.day_of_week;

-- ===================================== 6. dry-run derivation (R18) ========
SELECT '6. DRY RUN: what the Stage-1 punches would derive to NOW (nothing written)' AS section;

SELECT
  p.biomax_punch_id,
  p.user_id,
  p.io_time,
  d.derivation_status                                         AS stored_status,
  ne.employee_id,
  ws.shift_code,
  ELT(DAYOFWEEK(DATE_SUB(p.punch_date, INTERVAL 1 DAY)), 'Sun','Mon','Tue','Wed','Thu','Fri','Sat') AS previous_weekday,
  s.is_working_day                                            AS prev_row_working,
  s.attendance_day_cutoff                                     AS prev_row_cutoff,
  CASE
    WHEN ne.employee_id IS NULL                              THEN 'UNMATCHED'
    WHEN ne.default_work_shift_id IS NULL                    THEN 'NO_SHIFT'
    WHEN s.work_shift_weekly_schedule_id IS NULL             THEN 'NO_SCHEDULE_ROW'
    WHEN s.is_working_day = 1
         AND (s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '') THEN 'MISSING_CUTOFF'
    ELSE 'OK'
  END                                                         AS would_derive_status,
  CASE
    WHEN ne.employee_id IS NULL OR ne.default_work_shift_id IS NULL
         OR s.work_shift_weekly_schedule_id IS NULL           THEN NULL
    WHEN s.is_working_day <> 1                               THEN p.punch_date
    WHEN s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '' THEN NULL
    WHEN TIME(p.io_time) < s.attendance_day_cutoff           THEN DATE_SUB(p.punch_date, INTERVAL 1 DAY)
    ELSE p.punch_date
  END                                                         AS would_derive_attendance_date
FROM biomax_punch p
LEFT JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
-- same match as biomax/employeeMatch.js + store.js: user_id is the numeric employee_id, > 0
LEFT JOIN new_employee ne
  ON p.user_id REGEXP '^[0-9]+$' AND CAST(p.user_id AS UNSIGNED) > 0
 AND ne.employee_id = CAST(p.user_id AS UNSIGNED)
LEFT JOIN work_shift ws ON ws.work_shift_id = ne.default_work_shift_id
-- MySQL DAYOFWEEK: 1=Sunday..7=Saturday; schedule uses 0=Sunday..6=Saturday
LEFT JOIN work_shift_weekly_schedule s
  ON s.work_shift_id = ne.default_work_shift_id
 AND s.day_of_week = DAYOFWEEK(DATE_SUB(p.punch_date, INTERVAL 1 DAY)) - 1
ORDER BY p.biomax_punch_id;

SELECT '6b. SUMMARY: stored status vs would-derive status' AS section;

SELECT
  COALESCE(d.derivation_status, 'NO_DERIVED_ROW') AS stored_status,
  CASE
    WHEN ne.employee_id IS NULL                              THEN 'UNMATCHED'
    WHEN ne.default_work_shift_id IS NULL                    THEN 'NO_SHIFT'
    WHEN s.work_shift_weekly_schedule_id IS NULL             THEN 'NO_SCHEDULE_ROW'
    WHEN s.is_working_day = 1
         AND (s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = '') THEN 'MISSING_CUTOFF'
    ELSE 'OK'
  END AS would_derive_status,
  COUNT(*) AS punches
FROM biomax_punch p
LEFT JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
LEFT JOIN new_employee ne
  ON p.user_id REGEXP '^[0-9]+$' AND CAST(p.user_id AS UNSIGNED) > 0
 AND ne.employee_id = CAST(p.user_id AS UNSIGNED)
LEFT JOIN work_shift_weekly_schedule s
  ON s.work_shift_id = ne.default_work_shift_id
 AND s.day_of_week = DAYOFWEEK(DATE_SUB(p.punch_date, INTERVAL 1 DAY)) - 1
GROUP BY stored_status, would_derive_status;

-- ======================================================= 7. verdict ========
SELECT '7. GO / NO-GO: every count below must be 0 before pointing a terminal at the receiver' AS section;

SELECT
  (SELECT COUNT(*) FROM new_employee WHERE status = 1 AND default_work_shift_id IS NULL)      AS active_employees_without_shift,
  (SELECT COUNT(*) FROM new_employee ne JOIN work_shift ws ON ws.work_shift_id = ne.default_work_shift_id
     WHERE ne.status = 1 AND ws.active = 0)                                                    AS employees_on_inactive_shift,
  (SELECT COUNT(*) FROM (
     SELECT ws.work_shift_id FROM work_shift ws
     LEFT JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
     WHERE ws.active = 1 GROUP BY ws.work_shift_id
     HAVING COUNT(s.work_shift_weekly_schedule_id) <> 7) x)                                   AS active_shifts_missing_weekday_rows,
  (SELECT COUNT(*) FROM work_shift ws JOIN work_shift_weekly_schedule s ON s.work_shift_id = ws.work_shift_id
     WHERE ws.active = 1 AND s.is_working_day = 1
       AND (s.attendance_day_cutoff IS NULL OR s.attendance_day_cutoff = ''))                  AS working_rows_without_cutoff;
