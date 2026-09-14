-- =====================================================================
-- DN-ATTENDANCE-1865 — confirm the root cause, and size it.
--
-- READ-ONLY. Nothing here writes, and nothing here is employee-specific
-- except query 1, which is the reported case.
--
-- Run this BEFORE deploying the repair migration
-- (20261001120000-shift-history-gap-before-earliest): db-migrate echoes SQL
-- but not result sets, so the migration's own counts will not be visible in
-- the deploy log. Query 5 is the blast radius.
-- =====================================================================

-- 1. THE REPORTED EMPLOYEE ------------------------------------------------
--    Expect: default_work_shift_id set, status 1, and an assignment history
--    whose EARLIEST effective_from is LATER than 2026-09-02.
SELECT ne.employee_id, ne.default_work_shift_id, ne.shift_id AS legacy_shift_id,
       ne.date_of_joining, ne.status, ne.attendance_required
  FROM new_employee ne WHERE ne.employee_id = 1865;

SELECT employee_work_shift_assignment_id, work_shift_id,
       DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
       source, note, created_by, created_at
  FROM employee_work_shift_assignment
 WHERE employee_id = 1865
 ORDER BY effective_from, employee_work_shift_assignment_id;

-- 2. THE 17 PUNCHES -------------------------------------------------------
--    Expect: derivation_status NO_SHIFT, attendance_date NULL,
--    employee_id 1865 present (so they ARE matched - not an UNMATCHED case),
--    ingest_source DIGISME_IMPORT (the screen's "IMPORTED").
SELECT DATE_FORMAT(p.punch_date, '%Y-%m-%d') AS calendar_date,
       COUNT(*) AS punches,
       d.derivation_status,
       d.employee_id,
       d.work_shift_id AS derived_shift,
       DATE_FORMAT(d.attendance_date, '%Y-%m-%d') AS attendance_date,
       p.ingest_source
  FROM biomax_punch p
  JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
 WHERE (d.employee_id = 1865 OR p.user_id = '1865')
   AND p.punch_date BETWEEN '2026-09-01' AND '2026-09-14'
 GROUP BY calendar_date, d.derivation_status, d.employee_id, d.work_shift_id,
          attendance_date, p.ingest_source
 ORDER BY calendar_date;

-- 3. WHICH DIAGNOSIS IS TRUE ---------------------------------------------
--    One row per punch date, saying whether an assignment covers it.
--    'A/F: no covering assignment'  -> the history gap (expected)
--    'covered'                      -> the data is fine, look at B/C/D/E
SELECT dates.calendar_date,
       (SELECT MAX(a.effective_from) FROM employee_work_shift_assignment a
         WHERE a.employee_id = 1865 AND a.effective_from <= dates.calendar_date)
         AS covering_effective_from,
       CASE WHEN EXISTS (SELECT 1 FROM employee_work_shift_assignment a
                          WHERE a.employee_id = 1865
                            AND a.effective_from <= dates.calendar_date)
            THEN 'covered'
            ELSE 'A/F: no covering assignment' END AS verdict
  FROM (SELECT DISTINCT DATE(p.punch_date) AS calendar_date
          FROM biomax_punch p
          JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
         WHERE (d.employee_id = 1865 OR p.user_id = '1865')
           AND d.derivation_status IN ('NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF')) dates
 ORDER BY dates.calendar_date;

-- 4. RULE OUT "E: production is running old code" -------------------------
--    The new column only exists if this deploy's migration ran, and the
--    migration and the new resolver shipped in the same commit.
SELECT COUNT(*) AS attendance_required_column_present
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'new_employee' AND COLUMN_NAME = 'attendance_required';
SELECT name, run_on FROM migrations
 WHERE name LIKE '%attendance-required-and-shift-history-repair%'
    OR name LIKE '%shift-history-gap-before-earliest%'
 ORDER BY run_on;

-- 5. BLAST RADIUS — every employee with the same condition ----------------
--    Undatable punches on dates their assignment history does not reach.
--    This is the count the repair migration will act on.
SELECT COUNT(*) AS employees_affected,
       SUM(undatable_punches) AS punches_affected
  FROM (
    SELECT d.employee_id, COUNT(*) AS undatable_punches
      FROM biomax_punch_derived d
      JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
     WHERE d.derivation_status IN ('NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF')
       AND d.employee_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM employee_work_shift_assignment a
                        WHERE a.employee_id = d.employee_id
                          AND a.effective_from <= p.punch_date)
     GROUP BY d.employee_id
  ) affected;

-- 5b. ...and who they are, split by which repair applies.
SELECT d.employee_id,
       COUNT(*) AS undatable_punches,
       DATE_FORMAT(MIN(p.punch_date), '%Y-%m-%d') AS first_punch,
       DATE_FORMAT(MAX(p.punch_date), '%Y-%m-%d') AS last_punch,
       (SELECT DATE_FORMAT(MIN(a.effective_from), '%Y-%m-%d')
          FROM employee_work_shift_assignment a WHERE a.employee_id = d.employee_id)
         AS earliest_assignment,
       CASE WHEN NOT EXISTS (SELECT 1 FROM employee_work_shift_assignment a
                              WHERE a.employee_id = d.employee_id)
            THEN 'no history at all (first repair)'
            ELSE 'history starts too late (this repair)' END AS condition_kind
  FROM biomax_punch_derived d
  JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
 WHERE d.derivation_status IN ('NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF')
   AND d.employee_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM employee_work_shift_assignment a
                    WHERE a.employee_id = d.employee_id
                      AND a.effective_from <= p.punch_date)
 GROUP BY d.employee_id
 ORDER BY undatable_punches DESC;

-- 6. IS THE BIOMAX RECEIVER RELEVANT TO THESE PUNCHES? --------------------
--    LIVE punches come from the receiver process, which a backend deploy
--    does NOT reload. DIGISME_IMPORT / HISTORICAL_PULL punches do not.
SELECT p.ingest_source, d.derivation_status, COUNT(*) AS punches,
       DATE_FORMAT(MAX(p.punch_date), '%Y-%m-%d') AS most_recent
  FROM biomax_punch p
  JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
 WHERE p.punch_date >= '2026-09-01'
 GROUP BY p.ingest_source, d.derivation_status
 ORDER BY p.ingest_source, d.derivation_status;
