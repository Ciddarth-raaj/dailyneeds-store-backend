-- EMPLOYEE BRANCH SCOPE - one key, and who gets it.
--
-- The change this belongs to makes every employee read and every employee
-- write BRANCH-SCOPED BY DEFAULT: a caller sees and edits only the employees
-- of the branch they are assigned to in Employee Master. `view_employees` and
-- `employee_edit` still say WHETHER somebody may read or write an employee;
-- they no longer say WHERE, because they never should have.
--
-- Before this, a Store Manager at Kathirkamam holding `view_employees` could
-- read every employee in the company, and holding `employee_edit` could change
-- any of them - by opening /employee/<id> with an id from another branch, or
-- by calling the API directly.
--
--   employee_scope_all_branches   company-wide employee access
--
-- HR HOLDS IT. Administrators do not need it: the permission middleware
-- bypasses this table entirely for `user_type = 2`, and the resolver treats an
-- administrator as company-wide by user type, before any key is read.
--
-- IT IS GRANTED TO 'HR EXECUTIVE' AND TO NOBODY ELSE. That is the same
-- designation every earlier HR migration in this directory grants to, so the
-- rule is not being invented here. A second HR designation under another name,
-- or an Operations role that genuinely needs company-wide employee access, is
-- an administrator's deliberate decision on the designation rights screen -
-- where this key now appears - and not a migration's guess.
--
-- THE DIRECTION OF THIS CHANGE IS NARROWING. No designation gains anything it
-- did not have: HR keeps exactly the reach it has today, and every other
-- designation is confined to its own branch. If a designation turns out to
-- have needed company-wide access, granting this one key restores it - which
-- is a smaller and far more visible act than the blanket access it replaces.
--
-- NO TABLE, COLUMN OR EMPLOYEE ROW IS TOUCHED. One key declared, one grant
-- row written, both guarded so a re-run adds nothing.

-- ------------------------------------------------------------ declaration
-- `all_permissions` has no unique key on permission_key, so the insert guards
-- itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'employee_scope_all_branches' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'employee_scope_all_branches');

-- ------------------------------------------------------------------ grant
-- Guarded on (permission_key, designation_id) because `permissions` has no
-- unique key either. A row that exists but is INACTIVE is left alone:
-- re-enabling a permission an administrator switched off is their decision,
-- not a migration's.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'employee_scope_all_branches' AS `permission_key` ) k
    JOIN ( SELECT `designation_id` FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE' ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );
