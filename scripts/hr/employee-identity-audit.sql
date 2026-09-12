-- =====================================================================
-- READ-ONLY audit: employee identity and employee_family linkage
--
-- Run this BEFORE either of the two migrations below, and paste the output
-- into the review. Nothing here writes, locks or deletes.
--
--   20260925120000-employee-identity-guard   new_employee identity
--   20260926120000-employee-family-key       employee_family -> employee_id
--
-- Both migrations are additive and cannot fail on existing data. This audit
-- exists so the decisions they leave open - which duplicate rows to merge,
-- which family records cannot be attached automatically - are taken with the
-- real numbers in hand rather than guessed.
-- =====================================================================

-- 0. Engine, version, collation. NULL semantics in a UNIQUE index differ by
--    engine; InnoDB permits many NULLs, which is what lets the proposed
--    source-identity key coexist with locally created employees that have no
--    source. Collation decides whether "Amit P" and "amit p" are one name.
SELECT VERSION() AS mysql_version, @@default_storage_engine AS default_engine;
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('new_employee', 'employee_family', 'employee_aadhaar_identity');

-- 1. What keys and indexes exist today on the two tables.
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('new_employee', 'employee_family')
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- ============================================ new_employee: duplicates ===

-- 2. Total rows, and how many are current employment.
SELECT COUNT(*) AS employees,
       SUM(resignation_date IS NULL) AS no_resignation_date,
       SUM(status = 1) AS status_flag_1,
       SUM(status = 1 AND resignation_date IS NOT NULL) AS status_1_but_resigned
  FROM `new_employee`;

-- 3. Repeated names. This is the shape the paused sync left behind: many
--    rows, same name, consecutive ids, one per night. `created_at` spread is
--    what tells a genuine namesake (one row) from a sync loop (n rows, n
--    nights).
SELECT employee_name,
       COUNT(*) AS rows_with_this_name,
       COUNT(DISTINCT DATE(created_at)) AS distinct_create_days,
       MIN(employee_id) AS first_employee_id,
       MAX(employee_id) AS last_employee_id,
       MIN(created_at) AS first_created,
       MAX(created_at) AS last_created,
       SUM(resignation_date IS NULL) AS without_resignation_date
  FROM `new_employee`
 GROUP BY employee_name
HAVING COUNT(*) > 1
 ORDER BY rows_with_this_name DESC, employee_name;

-- 4. The same again, tightened by date of birth, which separates real
--    namesakes from copies. `date_of_joining` is VARCHAR and not comparable
--    here, so it is reported rather than grouped on.
SELECT employee_name, dob, COUNT(*) AS rows_with_this_name_and_dob,
       GROUP_CONCAT(employee_id ORDER BY employee_id) AS employee_ids,
       GROUP_CONCAT(DISTINCT date_of_joining ORDER BY date_of_joining) AS joining_dates
  FROM `new_employee`
 GROUP BY employee_name, dob
HAVING COUNT(*) > 1
 ORDER BY rows_with_this_name_and_dob DESC;

-- 5. Candidate stable identifiers, and how usable each one is as a unique
--    key TODAY. A column with many NULLs or duplicates cannot carry one.
SELECT 'primary_contact_number' AS candidate,
       COUNT(*) AS rows_total,
       SUM(primary_contact_number IS NULL OR TRIM(primary_contact_number) = '') AS empty_rows,
       COUNT(DISTINCT NULLIF(TRIM(primary_contact_number), '')) AS distinct_values
  FROM `new_employee`
UNION ALL
SELECT 'aadhaar_card_no',
       COUNT(*),
       SUM(aadhaar_card_no IS NULL OR TRIM(aadhaar_card_no) = ''),
       COUNT(DISTINCT NULLIF(TRIM(aadhaar_card_no), ''))
  FROM `new_employee`
UNION ALL
SELECT 'pan_no',
       COUNT(*),
       SUM(pan_no IS NULL OR TRIM(pan_no) = ''),
       COUNT(DISTINCT NULLIF(TRIM(pan_no), ''))
  FROM `new_employee`
UNION ALL
SELECT 'uan',
       COUNT(*),
       SUM(uan IS NULL OR TRIM(uan) = ''),
       COUNT(DISTINCT NULLIF(TRIM(uan), ''))
  FROM `new_employee`;

-- 6. Which of those candidates already hold duplicate non-empty values -
--    i.e. which would REJECT a UNIQUE key until the data is corrected.
SELECT 'primary_contact_number' AS candidate, v AS value, n AS rows_sharing_it FROM (
  SELECT NULLIF(TRIM(primary_contact_number), '') AS v, COUNT(*) AS n
    FROM `new_employee` GROUP BY v HAVING v IS NOT NULL AND n > 1) t1
UNION ALL
SELECT 'aadhaar_card_no', v, n FROM (
  SELECT NULLIF(TRIM(aadhaar_card_no), '') AS v, COUNT(*) AS n
    FROM `new_employee` GROUP BY v HAVING v IS NOT NULL AND n > 1) t2
UNION ALL
SELECT 'pan_no', v, n FROM (
  SELECT NULLIF(TRIM(pan_no), '') AS v, COUNT(*) AS n
    FROM `new_employee` GROUP BY v HAVING v IS NOT NULL AND n > 1) t3
 ORDER BY rows_sharing_it DESC;

-- 7. Duplicate rows that would be found by the ONE identity already under a
--    unique key: the Aadhaar fingerprint in employee_aadhaar_identity. A
--    duplicate employee whose Aadhaar has been captured twice cannot exist;
--    this counts how much of the master that covers.
SELECT (SELECT COUNT(*) FROM `new_employee`) AS employees,
       (SELECT COUNT(*) FROM `employee_aadhaar_identity`) AS aadhaar_identities,
       (SELECT COUNT(*) FROM `new_employee` ne
         WHERE NOT EXISTS (SELECT 1 FROM `employee_aadhaar_identity` a
                            WHERE a.employee_id = ne.employee_id)) AS employees_without_aadhaar_identity;

-- ======================================= employee_family: the name link ===

-- 8. Size of the problem.
SELECT COUNT(*) AS family_rows,
       COUNT(DISTINCT employee_name) AS distinct_employee_names
  FROM `employee_family`;

-- 9. Family rows whose employee_name matches EXACTLY ONE employee: these the
--    migration can attach automatically.
SELECT COUNT(*) AS resolvable_rows
  FROM `employee_family` f
  JOIN `new_employee` ne ON ne.employee_name = f.employee_name
 WHERE (SELECT COUNT(*) FROM `new_employee` x WHERE x.employee_name = f.employee_name) = 1;

-- 10. Family rows whose name matches SEVERAL employees. Ambiguous: the
--     migration leaves employee_id NULL and HR decides. These are exactly
--     the records the name key cannot distinguish today either.
SELECT f.employee_name,
       COUNT(DISTINCT f.family_id) AS family_rows,
       (SELECT COUNT(*) FROM `new_employee` x WHERE x.employee_name = f.employee_name) AS matching_employees,
       GROUP_CONCAT(DISTINCT f.family_id ORDER BY f.family_id) AS family_ids
  FROM `employee_family` f
 GROUP BY f.employee_name
HAVING matching_employees > 1
 ORDER BY family_rows DESC;

-- 11. Family rows whose name matches NO employee: already orphaned, most
--     likely by a name correction on new_employee.
SELECT f.family_id, f.employee_name, f.name AS family_member, f.relation
  FROM `employee_family` f
 WHERE NOT EXISTS (SELECT 1 FROM `new_employee` ne WHERE ne.employee_name = f.employee_name)
 ORDER BY f.employee_name, f.family_id;
