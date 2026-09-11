-- M1 - Employee Master restructure: two section-level permission keys.
--
-- The employee master is now one ordered set of sections for Add and Edit
-- alike: Aadhaar, Personal, Employment, Education, Payment Details,
-- Statutory Details, Payroll, Documents. `employee_create` covers the first
-- four (a store manager's onboarding). The two sections after them are HR's,
-- and until now both were written under the same pair of keys
-- (`add_employees` + `edit_employee_sensitive`), so a designation that could
-- record a PAN could also change a bank account and vice versa.
--
--   edit_payment_details     Payment Type (Cash / Bank) and the bank account
--   edit_statutory_details   PAN, PF applicability / UAN / PF number, ESI
--
-- NEITHER KEY REPLACES B3. The columns stay sensitive, so
-- `edit_employee_sensitive` is still demanded by `guardWrite`, and the
-- /employee/updatedata route still requires `add_employees`. These keys are
-- an additional, section-shaped check inside that route.
--
-- NO TABLE, COLUMN OR EMPLOYEE ROW IS TOUCHED. Additive only.

-- ------------------------------------------------------------ declarations
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_payment_details' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_payment_details');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_statutory_details' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_statutory_details');

-- ------------------------------------------------------------------ grants
-- Exactly the designations that can write these sections TODAY: an active
-- `add_employees` (the route) together with an active
-- `edit_employee_sensitive` (the field guard). Granting both new keys to
-- that set reproduces current access rather than widening or narrowing it.
-- `user_type = 2` needs no grant; the middleware bypasses this table.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'edit_payment_details' AS `permission_key`
           UNION ALL SELECT 'edit_statutory_details' ) k
    JOIN ( SELECT a.`designation_id`
             FROM `permissions` a
             JOIN `permissions` s
               ON s.`designation_id` = a.`designation_id`
              AND s.`permission_key` = 'edit_employee_sensitive'
              AND s.`is_active` = TRUE
            WHERE a.`permission_key` = 'add_employees'
              AND a.`is_active` = TRUE
            GROUP BY a.`designation_id` ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );
