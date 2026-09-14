-- VERIFYING AN EXISTING EMPLOYEE'S AADHAAR GETS ITS OWN, REMOVABLE KEY.
--
-- Roughly six hundred employees predate Aadhaar verification and carry no
-- identity at all. Clearing that backlog is branch work: the store manager
-- knows the person standing in front of them. But the only way to run the OTP
-- flow was the ONBOARDING path, `POST /hr/aadhaar/initiate`, which is gated on
-- `employee_create` and - because its body carries `aadhaar_number`, a B3
-- sensitive field - on `edit_employee_sensitive` as well. A store manager
-- holds neither, so the Verify now button on the employee profile ended in
-- "You do not have permission to perform this action" for an employee they
-- could see, could edit, and whose Aadhaar badge they were entitled to read.
--
-- The fix is NOT to grant them `edit_employee_sensitive`: that would open
-- salary, bank, PAN, PF and ESI writes in order to fix an Aadhaar badge, which
-- is the opposite of what B3 exists for. It is this key, on its own
-- existing-employee route pair:
--
--   verify_employee_aadhaar   start and complete Aadhaar OTP verification for
--                             an EXISTING employee whose Aadhaar is PENDING
--
-- AND IT IS MEANT TO BE TAKEN BACK. When the old-employee backlog is finished,
-- an administrator unticks this one box and the ability is gone - no other
-- capability moves, because no other capability was bundled into it. That is
-- the whole reason it is a key of its own rather than a widening of an
-- existing one.
--
-- ========================================================= WHAT IT IS NOT ===
--
--   not `view_employee_aadhaar`   reading the badge is not running the check
--   not `employee_edit`           which is still what ATTACHING a verified
--                                 Aadhaar requires, unchanged
--   not `edit_employee_sensitive` it grants no bank, PAN, PF or ESI write
--   not `view_aadhaar_full`       still granted to NOBODY; no digit beyond the
--                                 last four is readable with this
--   not `employee_create`         it hires nobody, and creating an employee
--                                 does not require it
--
-- IT ONLY EVER APPLIES TO A PENDING AADHAAR. The routes refuse an employee who
-- is already VERIFIED, so this can never be used to swap or overwrite a
-- verified identity - that stays a separate HR/Admin process.
--
-- AND IT GRANTS NO BRANCH. The routes apply this key AND the employee branch
-- scope, so a holder reaches only employees in the branches they are assigned
-- to. `employee_scope_all_branches` is untouched here.
--
-- ================================================== WHO IT IS GRANTED TO ===
--
-- 'HR EXECUTIVE' ONLY, by the one designation name this codebase already
-- relies on - as `20261004120000-employee-aadhaar-view-permission` and seven
-- earlier migrations in this directory do. HR runs this flow today through the
-- onboarding path and must not lose it when the existing-employee path becomes
-- the one the profile calls.
--
-- THERE IS NO CONTINUITY SET TO CARRY OVER. Unlike the status key, this gates
-- a NEW route: nobody holds it today, so no designation's effective access
-- narrows on deploy and none needs preserving.
--
-- STORE MANAGER IS DELIBERATELY NOT GRANTED HERE, and is the whole point of
-- the key. It is not inferred from `employee_create`, `employee_edit`,
-- `view_employees` or `view_employee_aadhaar` - those keys are held by
-- designations well beyond Store Manager, so inferring would hand Aadhaar
-- verification to roles nobody decided to give it to. Nor is a designation
-- guessed by NAME: `20260919120000-attendance-v2-approvals` already records
-- why, which designations are the Store Managers being a business fact nobody
-- has written down. An administrator ticks `Verify Employee Aadhaar` on the
-- Designation rights screen - one deliberate, visible, reversible decision -
-- and unticks it when the backlog is done.
--
-- Administrators need no grant: the permission middleware bypasses this table
-- for `user_type = 2`.
--
-- Additive and idempotent. No table, column or employee row is touched.

-- ------------------------------------------------------------ declaration
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'verify_employee_aadhaar' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'verify_employee_aadhaar');

-- ------------------------------------------------------------------ grant
-- HR, by the name this codebase already relies on. A row that exists but is
-- INACTIVE is left alone: re-enabling a permission an administrator switched
-- off is their decision, not a migration's.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'verify_employee_aadhaar', d.`designation_id`, TRUE
    FROM `designation` d
   WHERE UPPER(TRIM(d.`designation_name`)) = 'HR EXECUTIVE'
     AND NOT EXISTS (
       SELECT 1 FROM `permissions` p
        WHERE p.`permission_key` = 'verify_employee_aadhaar'
          AND p.`designation_id` = d.`designation_id` );
