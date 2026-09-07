-- =====================================================================
-- Stage 0A / C1, B9 — READ-ONLY account integrity audit
--
-- Run before any UNIQUE constraint is considered. Nothing here writes.
-- =====================================================================

-- 0. Engine and version (C1 asks for this explicitly: NULL semantics in
--    UNIQUE indexes differ between engines; InnoDB on MySQL permits many
--    NULLs, which is what lets a system account keep employee_id NULL).
SELECT VERSION() AS mysql_version, @@default_storage_engine AS default_engine;
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('user', 'new_employee', 'user_auth_log', 'user_password_reset');

-- 1. Duplicate usernames
SELECT username, COUNT(*) AS accounts, GROUP_CONCAT(user_id ORDER BY user_id) AS user_ids,
       SUM(status = 1) AS active_accounts
FROM `user`
GROUP BY username HAVING COUNT(*) > 1;

-- 2. NULL / empty usernames
SELECT user_id, employee_id, user_type, status FROM `user` WHERE username IS NULL OR TRIM(username) = '';

-- 3. Several accounts linked to one employee
SELECT employee_id, COUNT(*) AS accounts, GROUP_CONCAT(user_id ORDER BY user_id) AS user_ids,
       SUM(status = 1) AS active_accounts
FROM `user`
WHERE employee_id IS NOT NULL
GROUP BY employee_id HAVING COUNT(*) > 1;

-- 4. Accounts with no employee (expected: only is_system_account = 1)
SELECT user_id, username, user_type, status, is_system_account
FROM `user` WHERE employee_id IS NULL;

-- 5. Accounts whose employee_id does not exist in new_employee (orphans)
SELECT u.user_id, u.username, u.employee_id, u.status
FROM `user` u LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
WHERE u.employee_id IS NOT NULL AND ne.employee_id IS NULL;

-- 6. Username convention: employee-code style vs mobile-number style vs other
SELECT
  CASE
    WHEN username REGEXP '^[0-9]{10}$'                                     THEN 'mobile_style'
    WHEN username REGEXP '^[0-9]+$' AND CAST(username AS UNSIGNED) = employee_id THEN 'employee_id_style'
    WHEN username REGEXP '^[0-9]+$'                                        THEN 'numeric_other'
    ELSE 'text'
  END AS convention,
  COUNT(*) AS accounts, SUM(status = 1) AS active
FROM `user` GROUP BY convention;

-- 7. Collisions: a username that equals some OTHER employee's code or mobile
SELECT u.user_id, u.username, u.employee_id AS linked_employee,
       ne2.employee_id AS collides_with_employee, 'employee_code' AS via
FROM `user` u JOIN new_employee ne2 ON CAST(ne2.employee_id AS CHAR) = u.username
WHERE ne2.employee_id <> u.employee_id OR u.employee_id IS NULL
UNION ALL
SELECT u.user_id, u.username, u.employee_id, ne2.employee_id, 'mobile'
FROM `user` u JOIN new_employee ne2 ON ne2.primary_contact_number = u.username
WHERE ne2.employee_id <> u.employee_id OR u.employee_id IS NULL;

-- 8. Active account attached to an inactive employee (should be zero)
SELECT u.user_id, u.username, u.employee_id, ne.status AS employee_status, ne.resignation_date
FROM `user` u JOIN new_employee ne ON ne.employee_id = u.employee_id
WHERE u.status = 1 AND ne.status <> 1 AND u.is_system_account = 0;

-- 9. Suspected SHARED logins (B9): one account used from many addresses /
--    many user agents in the last 30 days. Needs user_auth_log populated.
SELECT l.user_id, u.username, ne.store_id,
       COUNT(DISTINCT l.ip)         AS distinct_ips,
       COUNT(DISTINCT l.user_agent) AS distinct_agents,
       COUNT(*)                     AS logins_30d
FROM user_auth_log l
JOIN `user` u ON u.user_id = l.user_id
LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
WHERE l.event = 'login_success' AND l.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY l.user_id
HAVING distinct_agents >= 3 OR logins_30d > 120
ORDER BY distinct_agents DESC, logins_30d DESC;

-- 10. Likely till/counter logins: accounts named like a store or a role
SELECT user_id, username, employee_id, user_type
FROM `user`
WHERE username REGEXP '(?i)(till|counter|cashier|store|branch|dn[0-9]|pos|billing|admin|test|demo)';
