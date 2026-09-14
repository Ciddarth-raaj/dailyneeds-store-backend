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
-- TWO SETS, AND NEITHER IS INFERRED FROM WHAT SOMEBODY CAN DO TO AN EMPLOYEE.
--
--   1. Designations that ALREADY hold `view_employee_lifecycle`. This is
--      CONTINUITY, not a grant: they are exactly the designations that can
--      read this Aadhaar status today, through the lifecycle gate this
--      migration replaces. Without it, re-keying the route would silently
--      TAKE the capability away from whoever holds lifecycle and is not HR.
--      The net effect on who can see what is zero.
--
--   2. 'HR EXECUTIVE', named explicitly, as seven earlier migrations in this
--      directory already do. Almost certainly a no-op beside (1), and stated
--      anyway so HR's access does not depend on a key they happen to hold.
--
-- STORE MANAGER IS DELIBERATELY NOT GRANTED HERE, and that is the correction
-- this version makes. An earlier draft inferred the grant from
-- `employee_create` / `employee_edit` - "they can already attach an Aadhaar,
-- so let them see it" - which reads reasonably and is wrong: those keys are
-- held by designations well beyond Store Manager, so the inference would have
-- handed Aadhaar visibility to roles nobody decided to give it to.
--
-- Nor is it granted by designation NAME. This codebase has already recorded
-- the reason, in `20260919120000-attendance-v2-approvals`: only 'HR EXECUTIVE'
-- is a designation name it relies on, and which designations are the Store
-- Managers "is a business fact nobody has recorded". A migration that guessed
-- would be assigning access in the one place it could never be reviewed.
--
-- SO THIS MIGRATION ALONE DOES NOT RESTORE AADHAAR FOR STORE MANAGERS. An
-- administrator ticks `view_employee_aadhaar` for their designation on the
-- Designation rights screen - one deliberate, visible, reversible decision,
-- which is precisely the approved rule: other designations get it only if we
-- give it to them. The route is ready for them the moment they do, and the
-- branch scope confines them to their own branches when they arrive.
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
-- One row per designation in either set. `UNION` de-duplicates, so a
-- designation in both is inserted once; `permissions` has no unique key to
-- catch a double insert.
--
-- A row that exists but is INACTIVE is left alone: re-enabling a permission an
-- administrator switched off is their decision, not a migration's.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'view_employee_aadhaar', d.`designation_id`, TRUE
    FROM (
           -- 1. continuity: everyone who can read Aadhaar status today
           SELECT `designation_id`
             FROM `permissions`
            WHERE `permission_key` = 'view_employee_lifecycle'
              AND `is_active` = TRUE
           UNION
           -- 2. HR, by the name this codebase already relies on
           SELECT `designation_id`
             FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE'
         ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = 'view_employee_aadhaar'
        AND p.`designation_id` = d.`designation_id` );
