-- Stage 0B / B2 — apply the rehearsal HR permission policy to a SCRATCH copy.
--
-- WRITES. Only ever run against a restored copy (dnds_rehearsal), never
-- against dnds_prod. The first statement below aborts the whole script with
-- "Subquery returns more than 1 row" if the current database is not named
-- like a scratch schema, so a mistyped database name cannot damage anything.
--
--   mysql --defaults-extra-file=~/.stage0a/app.cnf dnds_rehearsal \
--     --init-command="SET @HR_DESIGNATION := 11" \
--     < scripts/auth/b2-rehearsal-policy.sql
--
-- The policy:
--   * designation @HR_DESIGNATION (HR Executive) holds all 22 B2 HR keys
--   * every other designation holds none of those 22
--   * no other permission_key is read, written or deleted anywhere
--   * user_type = 2 (admin) is untouched; its bypass lives in code
--
-- Idempotent: the HR rows are cleared and re-inserted, so a second run leaves
-- exactly 22 active rows rather than 44, and the permissions table has no
-- unique key to rely on.

SELECT IF(
  DATABASE() LIKE '%rehearsal%' OR DATABASE() LIKE '%scratch%' OR DATABASE() LIKE '%restore_test%',
  'scratch schema confirmed',
  (SELECT 1 UNION ALL SELECT 2)   -- deliberately fails: refuses to run here
) AS guard;

SET @HR_DESIGNATION := IFNULL(@HR_DESIGNATION, 11);

-- 1. Declare the four B2 keys if the migration has not been applied to this
--    copy yet. Same statements as the migration; harmless if already there.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_employee_sensitive' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_employee_sensitive');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_employee_sensitive' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_employee_sensitive');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'add_documents' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'add_documents');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'add_stores' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'add_stores');

-- 2. Remove the 22 HR keys from every designation, including the HR one.
--    Clearing the HR designation too is what makes step 3 idempotent.
--    Nothing outside this list of 22 is touched.
DELETE FROM `permissions`
WHERE `permission_key` IN (
  'view_employees','add_employees','view_banks','add_banks','view_family','add_family',
  'view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive',
  'view_salary_advance','add_salary_advance','view_resignation','add_resignation',
  'view_designation','add_designation','view_department','add_department',
  'view_shift','add_shifts','view_stores','add_stores'
);

-- 3. Grant all 22 to the HR designation, active.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
SELECT k.`permission_key`, @HR_DESIGNATION, 1
FROM (
  SELECT 'view_employees' AS permission_key UNION ALL SELECT 'add_employees' UNION ALL
  SELECT 'view_banks'          UNION ALL SELECT 'add_banks'          UNION ALL
  SELECT 'view_family'         UNION ALL SELECT 'add_family'         UNION ALL
  SELECT 'view_documents'      UNION ALL SELECT 'add_documents'      UNION ALL
  SELECT 'view_employee_sensitive' UNION ALL SELECT 'edit_employee_sensitive' UNION ALL
  SELECT 'view_salary_advance' UNION ALL SELECT 'add_salary_advance' UNION ALL
  SELECT 'view_resignation'    UNION ALL SELECT 'add_resignation'    UNION ALL
  SELECT 'view_designation'    UNION ALL SELECT 'add_designation'    UNION ALL
  SELECT 'view_department'     UNION ALL SELECT 'add_department'     UNION ALL
  SELECT 'view_shift'          UNION ALL SELECT 'add_shifts'         UNION ALL
  SELECT 'view_stores'         UNION ALL SELECT 'add_stores'
) k;

SELECT CONCAT('policy applied to designation ', @HR_DESIGNATION, ' on ', DATABASE()) AS result;
