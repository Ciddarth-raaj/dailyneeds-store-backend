-- DN-ATTENDANCE-1865: history that begins AFTER the evidence.
--
-- THE DEFECT. The ordinary Employee Shift Assignment route dates an
-- assignment TODAY and never backdates - correctly, because moving somebody
-- to a new shift must not rewrite yesterday's worked minutes. But for an
-- employee who had NO shift at all, "today" means every earlier date
-- resolves to NO_SHIFT for ever, including days they demonstrably worked:
-- HR assigns the shift on the 12th, the punches are from the 2nd to the
-- 10th, and the punches stay undatable no matter how many times anybody
-- runs Recalculate. The resolver is behaving exactly as designed - there
-- genuinely is no assignment covering those dates.
--
-- The previous repair (20260930120000) does NOT cover this. Its guard is
-- per EMPLOYEE - "has no assignment row at all" - which is what makes it
-- safe, and also what makes it skip anybody whose history merely starts too
-- late. This migration closes that gap, and the application side is closed
-- in `repository/employee_work_shift.js#assignWorkShift`, where a
-- first-ever assignment is now dated from the start rather than from today.
--
-- WHAT IT DOES. For an employee who has assignment history that begins
-- AFTER the date their coverage should start, and who has PUNCH EVIDENCE in
-- the uncovered gap, it appends ONE row carrying their EARLIEST known shift,
-- effective from GREATEST(v2 cutover, joining date).
--
-- WHY THIS CANNOT MOVE A SETTLED FIGURE. The appended row is, by
-- construction, the employee's new EARLIEST row. The resolver takes the
-- greatest `effective_from` <= the attendance date, so for every date from
-- their previously-earliest row onward the OLD row still wins, unchanged. The
-- only dates whose resolution changes are those that resolve to nothing
-- today. A date can therefore go from NO SHIFT to a shift; no date can ever
-- go from one shift to a different one. A later shift change is untouchable.
--
-- WHICH SHIFT. The one on their earliest existing assignment - the first
-- shift there is any record of them being on. Not `default_work_shift_id`,
-- which is current state and may since have moved on.
--
-- EVIDENCE IS REQUIRED. Only employees with at least one UNDATABLE punch in
-- the gap are touched. Coverage is not invented for a period somebody may
-- simply not have worked; the repair follows the evidence.
--
-- APPEND-ONLY, like every row in this table. No UPDATE, no DELETE.
--
-- RE-RUNNABLE. After it runs, the employee's earliest row IS the row it
-- inserted, so `MIN(effective_from) > target` is false and a second run
-- inserts nothing.

-- ----------------------------------------------------------------- before
SELECT COUNT(*) AS `EMPLOYEES_WITH_PUNCHES_BEFORE_THEIR_EARLIEST_SHIFT_ROW`
  FROM (
  SELECT a.`employee_id`,
         MIN(a.`effective_from`) AS `earliest_from`,
         GREATEST('2026-09-01', COALESCE(CASE
                 WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
                 WHEN ne.date_of_joining LIKE '____-__-__%'
                      AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                   THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
                 ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
               END, '2026-09-01')) AS `target_from`,
         -- The shift on the EARLIEST row. Ordered the way the resolver
         -- orders, so the first element is the row resolution would pick.
         -- Only the first element is read, so GROUP_CONCAT's length limit
         -- can truncate the tail harmlessly.
         SUBSTRING_INDEX(
           GROUP_CONCAT(a.`work_shift_id`
                        ORDER BY a.`effective_from` ASC,
                                 a.`employee_work_shift_assignment_id` ASC),
           ',', 1) AS `earliest_work_shift_id`
    FROM `employee_work_shift_assignment` a
    JOIN `new_employee` ne ON ne.`employee_id` = a.`employee_id`
   -- `date_of_joining` is grouped as well as employee_id: it is functionally
   -- dependent through the primary-key join, but ONLY_FULL_GROUP_BY does not
   -- always infer that, and naming it is free.
   GROUP BY a.`employee_id`, ne.`date_of_joining`
  ) g
 WHERE g.`earliest_from` > g.`target_from`
  -- Real evidence they worked in the uncovered gap. Coverage is never
  -- invented for a period somebody may simply not have worked.
  AND EXISTS (
        SELECT 1
          FROM `biomax_punch_derived` d
          JOIN `biomax_punch` p ON p.`biomax_punch_id` = d.`biomax_punch_id`
         WHERE d.`employee_id` = g.`employee_id`
           AND d.`derivation_status` IN ('NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF')
           AND p.`punch_date` < g.`earliest_from` );

-- ------------------------------------------------------------- the repair
INSERT INTO `employee_work_shift_assignment`
       (`employee_id`, `work_shift_id`, `effective_from`, `source`, `note`, `created_by`)
  SELECT g.`employee_id`,
         g.`earliest_work_shift_id`,
         g.`target_from`,
         'MIGRATION_BACKFILL',
         'Repair: shift history began after punches that were already on record',
         NULL
    FROM (
  SELECT a.`employee_id`,
         MIN(a.`effective_from`) AS `earliest_from`,
         GREATEST('2026-09-01', COALESCE(CASE
                 WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
                 WHEN ne.date_of_joining LIKE '____-__-__%'
                      AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                   THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
                 ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
               END, '2026-09-01')) AS `target_from`,
         -- The shift on the EARLIEST row. Ordered the way the resolver
         -- orders, so the first element is the row resolution would pick.
         -- Only the first element is read, so GROUP_CONCAT's length limit
         -- can truncate the tail harmlessly.
         SUBSTRING_INDEX(
           GROUP_CONCAT(a.`work_shift_id`
                        ORDER BY a.`effective_from` ASC,
                                 a.`employee_work_shift_assignment_id` ASC),
           ',', 1) AS `earliest_work_shift_id`
    FROM `employee_work_shift_assignment` a
    JOIN `new_employee` ne ON ne.`employee_id` = a.`employee_id`
   -- `date_of_joining` is grouped as well as employee_id: it is functionally
   -- dependent through the primary-key join, but ONLY_FULL_GROUP_BY does not
   -- always infer that, and naming it is free.
   GROUP BY a.`employee_id`, ne.`date_of_joining`
    ) g
   WHERE g.`earliest_from` > g.`target_from`
  -- Real evidence they worked in the uncovered gap. Coverage is never
  -- invented for a period somebody may simply not have worked.
  AND EXISTS (
        SELECT 1
          FROM `biomax_punch_derived` d
          JOIN `biomax_punch` p ON p.`biomax_punch_id` = d.`biomax_punch_id`
         WHERE d.`employee_id` = g.`employee_id`
           AND d.`derivation_status` IN ('NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF')
           AND p.`punch_date` < g.`earliest_from` );

-- ------------------------------------------------------------------ after
-- Expect 0. Anything left is an employee whose punches predate even the v2
-- cutover or their own joining date; this deliberately invents no coverage
-- there and reports the count instead of guessing.
SELECT COUNT(*) AS `STILL_WITH_PUNCHES_BEFORE_THEIR_EARLIEST_SHIFT_ROW`
  FROM (
  SELECT a.`employee_id`,
         MIN(a.`effective_from`) AS `earliest_from`,
         GREATEST('2026-09-01', COALESCE(CASE
                 WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
                 WHEN ne.date_of_joining LIKE '____-__-__%'
                      AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                   THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
                 ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
               END, '2026-09-01')) AS `target_from`,
         -- The shift on the EARLIEST row. Ordered the way the resolver
         -- orders, so the first element is the row resolution would pick.
         -- Only the first element is read, so GROUP_CONCAT's length limit
         -- can truncate the tail harmlessly.
         SUBSTRING_INDEX(
           GROUP_CONCAT(a.`work_shift_id`
                        ORDER BY a.`effective_from` ASC,
                                 a.`employee_work_shift_assignment_id` ASC),
           ',', 1) AS `earliest_work_shift_id`
    FROM `employee_work_shift_assignment` a
    JOIN `new_employee` ne ON ne.`employee_id` = a.`employee_id`
   -- `date_of_joining` is grouped as well as employee_id: it is functionally
   -- dependent through the primary-key join, but ONLY_FULL_GROUP_BY does not
   -- always infer that, and naming it is free.
   GROUP BY a.`employee_id`, ne.`date_of_joining`
  ) g
 WHERE g.`earliest_from` > g.`target_from`
  -- Real evidence they worked in the uncovered gap. Coverage is never
  -- invented for a period somebody may simply not have worked.
  AND EXISTS (
        SELECT 1
          FROM `biomax_punch_derived` d
          JOIN `biomax_punch` p ON p.`biomax_punch_id` = d.`biomax_punch_id`
         WHERE d.`employee_id` = g.`employee_id`
           AND d.`derivation_status` IN ('NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF')
           AND p.`punch_date` < g.`earliest_from` );
