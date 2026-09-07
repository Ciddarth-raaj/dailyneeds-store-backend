-- =====================================================================
-- Stage 0A / A6 — READ-ONLY default-password scan
--
-- Run against a snapshot or with a read-only user. Nothing here writes.
--
-- Legacy passwords are unsalted SHA1(password) as MySQL computed them, so
-- an account whose stored value equals SHA1(<predictable string>) is using
-- that string. The patterns below are exactly the ones the provisioning
-- code produced (usecase/employee.js before Stage 0A) plus the obvious
-- identity-derived guesses. No password is output: only the account, its
-- branch, and which pattern category matched.
--
-- Only SHA-1 rows are examined. A row already on a modern hash cannot be
-- tested this way (that is the point of salting), which is why this scan
-- must run BEFORE hash-on-login migration is enabled.
-- =====================================================================

SELECT
  u.user_id,
  u.username,
  u.employee_id,
  u.user_type,
  u.status                       AS account_status,
  ne.status                      AS employee_status,
  ne.store_id,
  o.outlet_code,
  u.must_change_password,
  CASE
    WHEN u.password = SHA1(CONCAT(u.employee_id, '@123'))          THEN 'provisioning_default_employee_id_suffix'
    WHEN u.password = SHA1('password')                             THEN 'provisioning_default_literal'
    WHEN u.password = SHA1(CAST(u.employee_id AS CHAR))            THEN 'employee_id'
    WHEN u.password = SHA1(u.username)                             THEN 'username'
    WHEN ne.primary_contact_number IS NOT NULL
         AND u.password = SHA1(ne.primary_contact_number)          THEN 'mobile'
    WHEN ne.dob IS NOT NULL
         AND u.password IN (SHA1(DATE_FORMAT(ne.dob, '%d%m%Y')),
                            SHA1(DATE_FORMAT(ne.dob, '%d%m%y')),
                            SHA1(DATE_FORMAT(ne.dob, '%Y%m%d')),
                            SHA1(DATE_FORMAT(ne.dob, '%d-%m-%Y')),
                            SHA1(DATE_FORMAT(ne.dob, '%d/%m/%Y')))  THEN 'dob'
    WHEN u.password IN (SHA1('123456'), SHA1('12345678'), SHA1('123456789'),
                        SHA1('admin'), SHA1('admin123'), SHA1('welcome'),
                        SHA1('dailyneeds'), SHA1('dnds123'), SHA1('dnds@123'),
                        SHA1('store123'), SHA1('cashier'), SHA1('1234'))  THEN 'common'
    ELSE NULL
  END AS pattern_category
FROM `user` u
LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
LEFT JOIN outlets o       ON o.outlet_id = ne.store_id
WHERE u.password_algo = 'sha1'
  AND u.password IS NOT NULL
HAVING pattern_category IS NOT NULL
ORDER BY o.outlet_code, u.user_type DESC, u.user_id;

-- Summary counts for the report (pattern categories per branch):
SELECT
  o.outlet_code,
  SUM(u.password = SHA1(CONCAT(u.employee_id, '@123')))  AS provisioning_default_employee_id_suffix,
  SUM(u.password = SHA1('password'))                     AS provisioning_default_literal,
  SUM(u.password = SHA1(CAST(u.employee_id AS CHAR)))    AS employee_id,
  SUM(u.password = SHA1(u.username))                     AS username,
  SUM(ne.primary_contact_number IS NOT NULL AND u.password = SHA1(ne.primary_contact_number)) AS mobile,
  COUNT(*)                                               AS sha1_accounts_total
FROM `user` u
LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
LEFT JOIN outlets o       ON o.outlet_id = ne.store_id
WHERE u.password_algo = 'sha1' AND u.password IS NOT NULL AND u.status = 1
GROUP BY o.outlet_code WITH ROLLUP;
