-- Stage 0B / B2 — who loses access when authorisation is switched on.
--
-- READ ONLY. Run against a RESTORED COPY of production (the gate 5 scratch
-- schema), never against dnds_prod. Nothing here writes.
--
--   mysql --defaults-extra-file=~/.stage0a/app.cnf dnds_rehearsal < scripts/auth/b2-permission-gap.sql
--
-- B2 maps every HR endpoint to one permission key. Until now those endpoints
-- were reachable by any signed-in user (B1) and before that by anyone at all.
-- So the question this answers is not "who is over-privileged" but the
-- opposite: which designations are about to lose a screen they use today,
-- and therefore need a grant before B2 is deployed.
--
-- `user_type = 2` (admin) bypasses every check and is excluded throughout.

-- 1. Every designation with at least one active login, and how many of the
--    22 B2 keys it currently holds. A designation with 0 loses ALL HR
--    screens the moment B2 lands.
SELECT
  d.designation_id,
  d.designation_name,
  COUNT(DISTINCT u.user_id)                                       AS active_logins,
  COALESCE(SUM(p.permission_key IS NOT NULL), 0)                  AS hr_keys_held,
  COALESCE(GROUP_CONCAT(DISTINCT p.permission_key ORDER BY p.permission_key SEPARATOR ', '), '(none)') AS `keys_held`
FROM designation d
JOIN `user` u
  ON u.user_type <> 2
 AND u.status = 1
 AND u.is_system_account = 0
JOIN new_employee ne
  ON ne.employee_id = u.employee_id
 AND ne.status = 1
 AND ne.designation_id = d.designation_id
LEFT JOIN permissions p
  ON p.designation_id = d.designation_id
 AND p.is_active = 1
 AND p.permission_key IN (
   'view_employees','add_employees','view_banks','add_banks','view_family','add_family',
   'view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive',
   'view_salary_advance','add_salary_advance','view_resignation','add_resignation',
   'view_designation','add_designation','view_department','add_department',
   'view_shift','add_shifts','view_stores','add_stores'
 )
GROUP BY d.designation_id, d.designation_name
ORDER BY hr_keys_held ASC, active_logins DESC;

-- 2. The sharp edge: designations that will lose a screen they can use
--    today. Each row is a designation holding the read key of a module but
--    not the write key, or holding a module's key where B2 introduces a NEW
--    key nobody can hold yet (add_documents, add_stores,
--    view_employee_sensitive). These are the grants to make before deploying.
SELECT designation_id, designation_name, gap, note FROM (
  SELECT d.designation_id, d.designation_name,
         'add_documents' AS gap,
         'has view_documents; document create/update/approve will 403' AS note
  FROM designation d
  JOIN permissions v ON v.designation_id = d.designation_id AND v.is_active = 1 AND v.permission_key = 'view_documents'
  LEFT JOIN permissions w ON w.designation_id = d.designation_id AND w.is_active = 1 AND w.permission_key = 'add_documents'
  WHERE w.permission_key IS NULL

  UNION ALL
  SELECT d.designation_id, d.designation_name,
         'add_stores',
         'has view_stores; outlet create/update/status will 403'
  FROM designation d
  JOIN permissions v ON v.designation_id = d.designation_id AND v.is_active = 1 AND v.permission_key = 'view_stores'
  LEFT JOIN permissions w ON w.designation_id = d.designation_id AND w.is_active = 1 AND w.permission_key = 'add_stores'
  WHERE w.permission_key IS NULL

  UNION ALL
  SELECT d.designation_id, d.designation_name,
         'view_employee_sensitive',
         'has view_documents; GET /document/adhaar will 403'
  FROM designation d
  JOIN permissions v ON v.designation_id = d.designation_id AND v.is_active = 1 AND v.permission_key = 'view_documents'
  LEFT JOIN permissions s ON s.designation_id = d.designation_id AND s.is_active = 1 AND s.permission_key = 'view_employee_sensitive'
  WHERE s.permission_key IS NULL
) gaps
ORDER BY gap, designation_id;

-- 3. Rows switched off. B2 starts honouring `is_active`, which was written
--    but never read, so anything listed here silently worked until now and
--    stops working on deploy. Confirm each is intended before deploying.
SELECT p.designation_id, d.designation_name, p.permission_key
FROM permissions p
LEFT JOIN designation d ON d.designation_id = p.designation_id
WHERE p.is_active = 0
ORDER BY p.designation_id, p.permission_key;

-- 4. Sanity: the four new keys must exist in all_permissions after the B2
--    migration, and must be granted to nobody yet.
SELECT ap.permission_key,
       (SELECT COUNT(*) FROM permissions p WHERE p.permission_key = ap.permission_key AND p.is_active = 1) AS active_grants
FROM all_permissions ap
WHERE ap.permission_key IN ('view_employee_sensitive','edit_employee_sensitive','add_documents','add_stores')
ORDER BY ap.permission_key;
