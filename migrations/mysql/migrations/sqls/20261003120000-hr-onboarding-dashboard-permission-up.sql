-- THE HR ONBOARDING DASHBOARD - one key, and who gets it.
--
-- `/hr/onboarding` is HR's follow-up queue: whose employee record is not
-- finished, and what is missing. It is company-wide by nature, and a store
-- manager has no chasing to do on it, so it is not offered to them.
--
--   view_hr_onboarding_dashboard   may open the Onboarding / Pending HR queue
--
-- WHY THIS IS NOT `employee_scope_all_branches`, WHICH WOULD HAVE WORKED
-- TODAY. That key means company-wide EMPLOYEE SCOPE - which employees a
-- caller may be shown - and HR happens to hold it. Reusing it for the screen
-- would have tied two unrelated decisions together: the day company-wide
-- employee access is granted to some other designation, an Operations lead or
-- an auditor, that designation would silently acquire HR's work queue as
-- well. Nobody would have decided that, and nobody would have noticed. So the
-- screen gets a key of its own.
--
-- THE TWO STAY INDEPENDENT, IN BOTH DIRECTIONS. This key grants no employee
-- reach: a holder still sees exactly the employees their branch scope allows.
-- And the scope key opens no screen. HR is granted both, separately, because
-- HR genuinely needs both.
--
-- IT IS GRANTED TO 'HR EXECUTIVE' AND TO NOBODY ELSE - the same designation
-- every earlier HR migration in this directory grants to, so the rule is not
-- being invented here. Any other designation that should have the queue is an
-- administrator's deliberate decision on the designation rights screen, where
-- this key now appears, and not a migration's guess.
--
-- ADMINISTRATORS NEED NO GRANT. `user_type = 2` bypasses the permission table
-- entirely, exactly as it does for every other key.
--
-- NOTHING WIDENS ON DEPLOY. No designation gains anything: before this key
-- existed the screen was reached through the scope key, which only HR holds,
-- so HR's reach is unchanged and everybody else's is unchanged too.
--
-- NO TABLE, COLUMN OR EMPLOYEE ROW IS TOUCHED. One key declared, one grant
-- row written, both guarded so a re-run adds nothing.

-- ------------------------------------------------------------ declaration
-- `all_permissions` has no unique key on permission_key, so the insert guards
-- itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_hr_onboarding_dashboard' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_hr_onboarding_dashboard');

-- ------------------------------------------------------------------ grant
-- Guarded on (permission_key, designation_id) because `permissions` has no
-- unique key either. A row that exists but is INACTIVE is left alone:
-- re-enabling a permission an administrator switched off is their decision,
-- not a migration's.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'view_hr_onboarding_dashboard' AS `permission_key` ) k
    JOIN ( SELECT `designation_id` FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE' ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );
