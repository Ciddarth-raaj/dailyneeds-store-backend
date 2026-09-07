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
-- opposite: which designations are about to lose a screen they can reach
-- today. Every row below is a REVIEW CANDIDATE, not a grant to make. Losing
-- access to something nobody should have had is the point of B2, so each
-- candidate is a decision for whoever owns that data - never a default.
--
-- `user_type = 2` (admin) bypasses every check and is excluded throughout.

-- 1. Every designation with at least one active non-admin login, and how
--    many DISTINCT B2 keys it currently holds. A designation with 0 loses
--    every HR screen the moment B2 lands - which may well be correct.
SELECT
  d.designation_id,
  d.designation_name,
  COUNT(DISTINCT u.user_id)                                       AS active_logins,
  COUNT(DISTINCT p.permission_key)                                AS hr_keys_held,
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

-- 2. REVIEW CANDIDATES — designations that hold a module's read key today
--    and will meet a 403 on a related action once B2 lands, limited to
--    designations with at least one active non-admin login.
--
--    Read this as a list of questions, not a to-do list. B2 deliberately
--    separates reading from writing and ordinary data from sensitive data:
--
--      * holding `view_documents` says nothing about whether this designation
--        SHOULD be able to create, edit or approve documents;
--      * holding `view_stores` says nothing about whether it should be able
--        to create or edit an outlet;
--      * holding `view_documents` certainly says nothing about whether it
--        should see anyone's Aadhaar.
--
--    Before B1 these endpoints were open to everyone, so current holdings are
--    evidence of what the UI happened to expose, not of an access decision.
--    For each row decide: grant the key, or accept the loss. Granting every
--    row back would rebuild exactly the flat access B2 exists to end.
SELECT c.designation_id, c.designation_name, c.missing_key, c.affected_when_deployed, c.question
FROM (
  SELECT d.designation_id, d.designation_name,
         'add_documents' AS missing_key,
         'document create / update / approve returns 403' AS affected_when_deployed,
         'Does this designation actually file or approve documents, or only read them?' AS question
  FROM designation d
  JOIN permissions v ON v.designation_id = d.designation_id AND v.is_active = 1 AND v.permission_key = 'view_documents'
  LEFT JOIN permissions w ON w.designation_id = d.designation_id AND w.is_active = 1 AND w.permission_key = 'add_documents'
  WHERE w.permission_key IS NULL

  UNION ALL
  SELECT d.designation_id, d.designation_name,
         'add_stores',
         'outlet create / update / status returns 403',
         'Does this designation maintain outlet records, or only look them up?'
  FROM designation d
  JOIN permissions v ON v.designation_id = d.designation_id AND v.is_active = 1 AND v.permission_key = 'view_stores'
  LEFT JOIN permissions w ON w.designation_id = d.designation_id AND w.is_active = 1 AND w.permission_key = 'add_stores'
  WHERE w.permission_key IS NULL

  UNION ALL
  SELECT d.designation_id, d.designation_name,
         'view_employee_sensitive',
         'GET /document/adhaar returns 403',
         'Should this designation see Aadhaar at all? Default answer is no.'
  FROM designation d
  JOIN permissions v ON v.designation_id = d.designation_id AND v.is_active = 1 AND v.permission_key = 'view_documents'
  LEFT JOIN permissions s ON s.designation_id = d.designation_id AND s.is_active = 1 AND s.permission_key = 'view_employee_sensitive'
  WHERE s.permission_key IS NULL
) c
JOIN (
  -- designations that actually have someone signing in as them
  SELECT DISTINCT ne.designation_id
  FROM `user` u
  JOIN new_employee ne ON ne.employee_id = u.employee_id AND ne.status = 1
  WHERE u.user_type <> 2 AND u.status = 1 AND u.is_system_account = 0
) live ON live.designation_id = c.designation_id
ORDER BY c.missing_key, c.designation_id;

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
