-- =====================================================================
-- Stage 0A / gate 14 — READ-ONLY diagnosis of employees with more than one
-- login row. Run against the restored rehearsal copy only.
--
-- Output is identifiers and categories: user_id, username, employee_id,
-- flags. No password value or hash is ever selected; hashes are only
-- compared to each other and to the known default patterns inside SQL.
-- =====================================================================

-- A. the duplicate set itself
SELECT employee_id,
       COUNT(*)                                   AS login_rows,
       SUM(status = 1)                            AS active_rows,
       GROUP_CONCAT(user_id ORDER BY user_id)     AS user_ids
FROM `user`
WHERE employee_id IS NOT NULL
GROUP BY employee_id
HAVING COUNT(*) > 1;

-- B. each login row of a duplicated employee, side by side
SELECT
  u.employee_id,
  u.user_id,
  u.username,
  u.user_type,
  u.status                                                        AS account_status,
  u.ip_policy,
  (u.allowed_ips IS NOT NULL AND u.allowed_ips <> '')             AS has_allowed_ips,
  EXISTS (SELECT 1 FROM telegram_links tl WHERE tl.user_id = u.user_id) AS telegram_linked,
  CASE
    WHEN u.password IS NULL OR u.password = ''                     THEN 'empty'
    WHEN u.password = SHA1(CONCAT(u.employee_id, '@123'))          THEN 'provisioning_default_employee_id_suffix'
    WHEN u.password = SHA1('password')                             THEN 'provisioning_default_literal'
    WHEN u.password = SHA1(u.username)                             THEN 'username'
    WHEN u.password = SHA1(CAST(u.employee_id AS CHAR))            THEN 'employee_id'
    ELSE 'not_a_known_default'
  END                                                             AS password_pattern,
  (SELECT COUNT(*) - 1 FROM `user` s
     WHERE s.employee_id = u.employee_id AND s.password = u.password) AS siblings_with_identical_password,
  CASE
    WHEN u.username REGEXP '^[0-9]{10}$'                           THEN 'mobile_style'
    WHEN u.username = CAST(u.employee_id AS CHAR)                  THEN 'employee_id_style'
    WHEN u.username REGEXP '^[0-9]+$'                              THEN 'numeric_other'
    ELSE 'text'
  END                                                             AS username_convention,
  (ne.primary_contact_number IS NOT NULL
     AND u.username = ne.primary_contact_number)                   AS username_is_employee_mobile,
  ne.status                                                       AS employee_status,
  ne.designation_id,
  ne.store_id,
  ne.date_of_joining,
  ne.resignation_date
FROM `user` u
LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
WHERE u.employee_id IN (
  SELECT employee_id FROM `user` WHERE employee_id IS NOT NULL
  GROUP BY employee_id HAVING COUNT(*) > 1
)
ORDER BY u.employee_id, u.user_id;

-- C. does either username of a duplicated employee also belong to ANOTHER
--    employee's code or mobile (a collision would make the duplicate a
--    cross-identity problem rather than a same-person one)?
SELECT u.user_id, u.username, u.employee_id AS linked_employee,
       ne2.employee_id AS also_matches_employee, 'employee_code' AS via
FROM `user` u
JOIN new_employee ne2 ON CAST(ne2.employee_id AS CHAR) = u.username
WHERE u.employee_id IN (SELECT employee_id FROM `user` WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1)
  AND ne2.employee_id <> u.employee_id
UNION ALL
SELECT u.user_id, u.username, u.employee_id, ne2.employee_id, 'mobile'
FROM `user` u
JOIN new_employee ne2 ON ne2.primary_contact_number = u.username
WHERE u.employee_id IN (SELECT employee_id FROM `user` WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1)
  AND ne2.employee_id <> u.employee_id;

-- D. what each row can do: permissions come from the employee's designation,
--    so every login row of the same employee carries the same permission
--    set. Listed once per employee (count only).
SELECT ne.employee_id, ne.designation_id,
       (SELECT COUNT(*) FROM permissions p WHERE p.designation_id = ne.designation_id) AS designation_permission_count,
       MAX(u.user_type) AS highest_user_type_among_rows
FROM new_employee ne
JOIN `user` u ON u.employee_id = ne.employee_id
WHERE ne.employee_id IN (SELECT employee_id FROM `user` WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1)
GROUP BY ne.employee_id, ne.designation_id;
