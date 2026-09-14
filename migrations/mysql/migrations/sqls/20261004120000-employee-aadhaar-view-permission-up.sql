-- THE AADHAAR STATUS READ GETS ITS OWN KEY.
--
-- `GET /hr/employee/:id/aadhaar` answers one question - does this employee
-- have a verified Aadhaar, and if so the last four digits and the verified
-- name. It was gated on `view_employee_lifecycle`, which is the EMPLOYMENT
-- HISTORY key: periods, resignations, rejoins.
--
-- A store manager does not hold that key. So the employee profile told them
-- "Aadhaar status not available with your access" for employees they had
-- personally onboarded - having run the Aadhaar verification themselves under
-- `employee_create`, and being able to attach one under `employee_edit`. They
-- could create the identity and not see it. Aadhaar identity and employment
-- history are different questions and one must not gate the other.
--
--   view_employee_aadhaar   read the Aadhaar STATUS of one employee
--
-- WHAT IT IS NOT. It is not `view_aadhaar_full`, which reads the twelve
-- digits back and is still granted to NOBODY. It is not `employee_edit`,
-- which is what attaching an Aadhaar still requires. And it grants no branch:
-- the route applies this key AND the branch scope, so a holder still reads
-- only employees in the branches they are assigned to, and HR and
-- administrators remain company-wide exactly as before.
--
-- ================================================== WHO IT IS GRANTED TO ===
--
-- Chosen from what designations ALREADY hold, rather than by naming a
-- designation, so the grant follows this database rather than a guess:
--
--   view_employee_lifecycle   everyone who can read this status TODAY. They
--                             keep it, so the change takes nothing away.
--   employee_create           the onboarding population - they already run
--                             the Aadhaar verification itself.
--   employee_edit             they can already ATTACH a verified Aadhaar to
--                             an employee.
--
-- THE SECOND AND THIRD ARE A DELIBERATE WIDENING, and it is the one the
-- approved rule asks for: these designations can already create the Aadhaar
-- identity, and this lets them see the status of the thing they created.
-- Nothing else moves - no salary, bank, PAN, employment history or
-- cross-branch access comes with it.
--
-- Administrators need no grant: the permission middleware bypasses this table
-- for `user_type = 2`.
--
-- Additive and idempotent. No table, column or employee row is touched.

-- ------------------------------------------------------------ declaration
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_employee_aadhaar' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_employee_aadhaar');

-- ------------------------------------------------------------------ grant
-- One row per designation that already holds any of the three source keys.
-- `DISTINCT` because a designation holding two of them must not be inserted
-- twice; `permissions` has no unique key to catch it.
--
-- A row that exists but is INACTIVE is left alone: re-enabling a permission
-- an administrator switched off is their decision, not a migration's.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'view_employee_aadhaar', d.`designation_id`, TRUE
    FROM ( SELECT DISTINCT `designation_id`
             FROM `permissions`
            WHERE `permission_key` IN ('view_employee_lifecycle', 'employee_create', 'employee_edit')
              AND `is_active` = TRUE ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = 'view_employee_aadhaar'
        AND p.`designation_id` = d.`designation_id` );
