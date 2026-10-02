-- =====================================================================
-- An active employee is missing from Employee Master / HR Onboarding /
-- employee pickers. First case: 1530 - Sathiya Priya.
--
-- PREFER employee-directory-visibility.js (SELECT-only, session READ ONLY, uses the
-- deployed code for the "before" answer). This file sets one session variable.
--
-- READ-ONLY. Nothing here writes. Run it on production as it is and paste the
-- result sets back. Only @emp is employee-specific.
--
-- THE SUSPECTED ROOT CAUSE. `GET /employee/employees` (EmployeeUsecase.get ->
-- repository/employee_scope.js#directoryPopulation) excluded EVERY row whose
-- `employee_name` appears anywhere in `resignation`:
--
--     WHERE new_employee.employee_name NOT IN (SELECT employee_name FROM resignation)
--
-- `resignation` is keyed by NAME, so an ACTIVE employee disappears when
--   (a) a different employee with the same name resigned       -> block 3 shows
--       a row whose employee_id is NULL or not @emp, and block 2 a namesake
--   (b) they were resigned and REJOINED through HR             -> block 3 row has
--       employee_id = @emp, block 5 shows a closed and an open period
--   (c) a resignation of theirs was VOIDED                      -> block 3 row has
--       voided_at set
-- The name comparison uses the column collation, so case and trailing spaces
-- do not protect a namesake ('SATHIYA PRIYA ' matches 'Sathiya Priya').
--
-- THE SEARCH (`/employee/filter`, status = 1) HAS NO NAME EXCLUSION, so in all
-- three cases the employee is found by search but missing from the list.
--
-- WHAT RULES THE OTHER CAUSES OUT, block by block:
--   status <> 1, store_id NULL / unknown outlet       -> block 1 / block 6
--   duplicate or wrong employee_id                    -> block 1 (one row), block 10
--   onboarding / Aadhaar left partial                  -> block 7 (does NOT hide a
--                                                         row; it only sets the
--                                                         hr_onboarding_pending badge)
--   attendance / payroll not linked                    -> block 8 / block 9
--   outlet scope of the viewing user                   -> block 11
-- =====================================================================

SET @emp := 1530;

-- 1. IDENTITY - every lifecycle, scope and onboarding field the list reads ----
--    Expect exactly ONE row. Visible to the directory needs: status = 1 (for
--    the screen's default Active filter), store_id a real outlet, and
--    hidden_by_resignation_name = 0.
SELECT ne.employee_id, ne.employee_name, CHAR_LENGTH(ne.employee_name) AS name_len,
       HEX(ne.employee_name) AS name_hex,
       ne.status, ne.resignation_date, ne.date_of_joining,
       ne.store_id, o.outlet_name, ne.designation_id, d.designation_name,
       ne.department_id, ne.shift_id, ne.default_work_shift_id,
       ne.payment_type, ne.pf_applicable, ne.esi_applicable,
       ne.attendance_required, ne.works_all_locations,
       ne.created_at, ne.updated_at,
       (ne.employee_name IN (SELECT r.employee_name FROM resignation r)) AS hidden_by_resignation_name
  FROM new_employee ne
  LEFT JOIN outlets o      ON o.outlet_id = ne.store_id
  LEFT JOIN designation d  ON d.designation_id = ne.designation_id
 WHERE ne.employee_id = @emp;

-- 2. NAMESAKES - any other employee whose name compares equal ---------------
SELECT ne.employee_id, ne.employee_name, ne.status, ne.resignation_date,
       ne.store_id, o.outlet_name, ne.date_of_joining, ne.created_at
  FROM new_employee ne
  LEFT JOIN outlets o ON o.outlet_id = ne.store_id
 WHERE ne.employee_name = (SELECT employee_name FROM new_employee WHERE employee_id = @emp)
 ORDER BY ne.employee_id;

-- 3. THE DECISIVE BLOCK - resignation rows that match the name --------------
--    Any row here means the PRODUCTION directory clause hides @emp.
SELECT r.resignation_id, r.employee_id AS resignation_employee_id, r.period_id,
       r.employee_name, r.reason_type, r.resignation_date, r.voided_at, r.voided_by,
       CASE
         WHEN r.voided_at IS NOT NULL            THEN 'c: voided resignation'
         WHEN r.employee_id = @emp               THEN 'b: own resignation (rejoined?)'
         WHEN r.employee_id IS NULL              THEN 'a?: legacy name-only row'
         ELSE 'a: namesake resignation'
       END AS case_label
  FROM resignation r
 WHERE r.employee_name = (SELECT employee_name FROM new_employee WHERE employee_id = @emp)
 ORDER BY r.resignation_id;

-- 4. THE EXACT PRODUCTION PREDICATE vs THE FIXED ONE -------------------------
--    before = 0 and after = 1 proves the name exclusion is the cause.
SELECT ne.employee_id,
       (ne.employee_name NOT IN (SELECT employee_name FROM resignation)) AS listed_before_fix,
       (ne.employee_name NOT IN (SELECT employee_name FROM resignation) OR ne.status = 1) AS listed_after_fix
  FROM new_employee ne
 WHERE ne.employee_id = @emp;

-- 5. LIFECYCLE HISTORY ------------------------------------------------------
SELECT period_id, period_no, period_state, joined_on, ended_on, end_reason_type, source, needs_review,
       created_at, updated_at
  FROM employee_employment_period WHERE employee_id = @emp ORDER BY period_no;
SELECT event_id, period_id, event_type, actor_employee_id, created_at
  FROM employee_lifecycle_event WHERE employee_id = @emp ORDER BY event_id;

-- 6. OUTLET IS REAL ---------------------------------------------------------
SELECT o.outlet_id, o.outlet_name
  FROM outlets o
 WHERE o.outlet_id = (SELECT store_id FROM new_employee WHERE employee_id = @emp);

-- 7. AADHAAR / ONBOARDING (badge only - never removes a row from the list) ---
SELECT employee_id, verification_id, verified_at
  FROM employee_aadhaar_identity WHERE employee_id = @emp;
SELECT COUNT(*) AS aadhaar_verification_attempts
  FROM employee_aadhaar_verification WHERE employee_id = @emp;

-- 8. PAYROLL ----------------------------------------------------------------
SELECT COUNT(*) AS salary_rows FROM employee_salary WHERE employee_id = @emp;
SELECT period_year, period_month, store_id, store_name, employee_name
  FROM payrun_employee WHERE employee_id = @emp ORDER BY period_year DESC, period_month DESC LIMIT 6;

-- 9. ATTENDANCE (Biomax / DigiSME import key by Employee Code) ---------------
SELECT ingest_source, COUNT(*) AS punches, MIN(punch_date) AS first_punch, MAX(punch_date) AS last_punch
  FROM biomax_punch WHERE user_id = CAST(@emp AS CHAR) GROUP BY ingest_source;
SELECT COUNT(*) AS calculated_days, MIN(attendance_date) AS first_day, MAX(attendance_date) AS last_day
  FROM attendance_day_calculation WHERE employee_id = @emp;

-- 10. LOGIN ACCOUNTS / MAPPING ----------------------------------------------
SELECT user_id, employee_id, status, user_type FROM `user` WHERE employee_id = @emp;

-- 11. NEARBY WORKING EMPLOYEE - same outlet and designation, side by side ----
SELECT ne.employee_id, ne.employee_name, ne.status, ne.resignation_date, ne.date_of_joining,
       ne.store_id, ne.designation_id, ne.payment_type, ne.created_at,
       (ne.employee_name IN (SELECT r.employee_name FROM resignation r)) AS hidden_by_resignation_name
  FROM new_employee ne
 WHERE ne.store_id = (SELECT store_id FROM new_employee WHERE employee_id = @emp)
   AND ne.designation_id = (SELECT designation_id FROM new_employee WHERE employee_id = @emp)
   AND ne.status = 1
 ORDER BY ABS(ne.employee_id - @emp)
 LIMIT 5;

-- 12. BLAST RADIUS - every ACTIVE employee the production clause hides -------
--     This is the list the fix makes visible again. Nobody inactive is on it.
SELECT ne.employee_id, ne.employee_name, ne.store_id, o.outlet_name, ne.date_of_joining,
       GROUP_CONCAT(DISTINCT CONCAT_WS(':', r.resignation_id, IFNULL(r.employee_id, 'name-only'),
                                       IF(r.voided_at IS NULL, 'live', 'voided'))) AS matching_resignations
  FROM new_employee ne
  JOIN resignation r ON r.employee_name = ne.employee_name
  LEFT JOIN outlets o ON o.outlet_id = ne.store_id
 WHERE ne.status = 1
 GROUP BY ne.employee_id, ne.employee_name, ne.store_id, o.outlet_name, ne.date_of_joining
 ORDER BY ne.employee_id;

-- 13. LEGACY WRONG-PERSON RISK - names shared by several employees AND a ----
--     resignation. The legacy Resign screen deactivates the FIRST employee
--     with the name (`getEmployeeIdByName`), which may not be who left.
SELECT ne.employee_name, COUNT(DISTINCT ne.employee_id) AS employees,
       GROUP_CONCAT(DISTINCT CONCAT(ne.employee_id, '/s', ne.status) ORDER BY ne.employee_id) AS ids_status,
       COUNT(DISTINCT r.resignation_id) AS resignation_rows
  FROM new_employee ne
  JOIN resignation r ON r.employee_name = ne.employee_name
 GROUP BY ne.employee_name
HAVING COUNT(DISTINCT ne.employee_id) > 1
 ORDER BY employees DESC, ne.employee_name;
