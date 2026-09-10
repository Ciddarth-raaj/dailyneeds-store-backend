-- Stage 0B / B2 — verify the rehearsal HR permission policy. READ ONLY.
--
--   mysql --defaults-extra-file=~/.stage0a/app.cnf --table dnds_rehearsal \
--     --init-command="SET @HR_DESIGNATION := 11" \
--     < scripts/auth/b2-rehearsal-verify.sql
--
-- Every section prints PASS or FAIL on its own line so the result can be read
-- without counting rows by hand.

SET @HR_DESIGNATION := IFNULL(@HR_DESIGNATION, 11);
SET @HR_KEYS := "'view_employees','add_employees','view_banks','add_banks','view_family','add_family','view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive','view_salary_advance','add_salary_advance','view_resignation','add_resignation','view_designation','add_designation','view_department','add_department','view_shift','add_shifts','view_stores','add_stores'";

-- A. the HR designation holds exactly 22 active HR keys, no duplicates
SELECT
  @HR_DESIGNATION                                   AS hr_designation_id,
  COUNT(*)                                          AS rows_total,
  COUNT(DISTINCT permission_key)                    AS distinct_keys,
  SUM(is_active = 1)                                AS active_rows,
  IF(COUNT(*) = 22 AND COUNT(DISTINCT permission_key) = 22 AND SUM(is_active = 1) = 22,
     'PASS', 'FAIL')                                AS verdict
FROM permissions
WHERE designation_id = @HR_DESIGNATION
  AND permission_key IN (
    'view_employees','add_employees','view_banks','add_banks','view_family','add_family',
    'view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive',
    'view_salary_advance','add_salary_advance','view_resignation','add_resignation',
    'view_designation','add_designation','view_department','add_department',
    'view_shift','add_shifts','view_stores','add_stores'
  );

-- B. every other designation holds zero HR keys (active or not)
SELECT
  COUNT(*)                       AS stray_hr_rows_on_other_designations,
  IF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM permissions
WHERE designation_id <> @HR_DESIGNATION
  AND permission_key IN (
    'view_employees','add_employees','view_banks','add_banks','view_family','add_family',
    'view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive',
    'view_salary_advance','add_salary_advance','view_resignation','add_resignation',
    'view_designation','add_designation','view_department','add_department',
    'view_shift','add_shifts','view_stores','add_stores'
  );

-- B2. and if any stray rows exist, name them
SELECT designation_id, permission_key, is_active
FROM permissions
WHERE designation_id <> @HR_DESIGNATION
  AND permission_key IN (
    'view_employees','add_employees','view_banks','add_banks','view_family','add_family',
    'view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive',
    'view_salary_advance','add_salary_advance','view_resignation','add_resignation',
    'view_designation','add_designation','view_department','add_department',
    'view_shift','add_shifts','view_stores','add_stores'
  )
ORDER BY designation_id, permission_key;

-- C. non-HR permissions are untouched: how many remain, per designation.
--    Compare this against the same query taken BEFORE the policy ran; the
--    orchestrator script does that comparison automatically.
SELECT designation_id,
       COUNT(*)                       AS non_hr_permission_rows,
       SUM(is_active = 1)             AS active_rows
FROM permissions
WHERE permission_key NOT IN (
  'view_employees','add_employees','view_banks','add_banks','view_family','add_family',
  'view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive',
  'view_salary_advance','add_salary_advance','view_resignation','add_resignation',
  'view_designation','add_designation','view_department','add_department',
  'view_shift','add_shifts','view_stores','add_stores'
)
GROUP BY designation_id
ORDER BY designation_id;

-- D. who is affected: active non-admin logins by designation, and whether
--    that designation now holds HR access.
SELECT
  ne.designation_id,
  d.designation_name,
  COUNT(DISTINCT u.user_id) AS active_logins,
  IF(ne.designation_id = @HR_DESIGNATION, 'HR - full HR access', 'no HR access') AS after_policy
FROM `user` u
JOIN new_employee ne ON ne.employee_id = u.employee_id AND ne.status = 1
LEFT JOIN designation d ON d.designation_id = ne.designation_id
WHERE u.user_type <> 2 AND u.status = 1 AND u.is_system_account = 0
GROUP BY ne.designation_id, d.designation_name
ORDER BY active_logins DESC;

-- E. the four new keys exist and are granted only to the HR designation
SELECT ap.permission_key,
       (SELECT COUNT(*) FROM permissions p
         WHERE p.permission_key = ap.permission_key AND p.is_active = 1) AS active_grants,
       (SELECT COUNT(*) FROM permissions p
         WHERE p.permission_key = ap.permission_key AND p.is_active = 1
           AND p.designation_id = @HR_DESIGNATION)                       AS granted_to_hr
FROM all_permissions ap
WHERE ap.permission_key IN ('view_employee_sensitive','edit_employee_sensitive','add_documents','add_stores')
ORDER BY ap.permission_key;
