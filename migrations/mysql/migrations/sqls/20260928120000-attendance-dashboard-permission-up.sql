-- The Attendance Dashboard - ONE permission key, and one grant rule.
--
-- ADDITIVE AND PERMISSION-ONLY. This migration creates no table, alters no
-- table, adds no column, adds no index and touches no attendance, shift,
-- punch or payroll data. The dashboard reads tables that already exist and
-- stores nothing of its own, so there is nothing here but the right to read
-- it. Re-running it adds nothing (every statement guards itself).
--
-- WHY A NEW KEY RATHER THAN REUSING `view_calculated_attendance`.
-- `view_calculated_attendance` answers "may this person open ONE employee's
-- calculated month". The dashboard answers "how is the whole company doing
-- today", and although every individual figure behind it is one that key
-- already permits, an aggregate across everybody is a wider read and deserves
-- to be grantable and revocable on its own. A designation can now be given
-- the overview without the per-employee screen, or the per-employee screen
-- without the overview.
--
-- IT IS A READ KEY AND GRANTS NO WRITE. Holding it does not let anybody
-- approve a regularization or an OT request, edit a punch time, change a
-- date's shift, void a punch or recalculate anything. Every action the screen
-- links out to keeps its own existing key and is re-checked by the route that
-- performs it; the dashboard router is GET-only and has no write path at all.
--
-- THE GRANT RULE: whoever already holds `view_calculated_attendance`.
-- Those designations can already read every one of these employees' days one
-- at a time, so granting them the overview changes what is CONVENIENT and not
-- what is VISIBLE - nobody's effective access widens on deploy. This is the
-- same reasoning the M1 migration used when it granted its two new keys only
-- to designations that already held the underlying ones.
--
-- NOBODY ELSE IS GRANTED ANYTHING. There is no grant to "all designations",
-- no grant by user type and no grant to a designation that does not already
-- hold the read above. Administrators (user_type 2) need no row: the
-- permission middleware bypasses this table for them.
--
-- `all_permissions` has no unique key on `permission_key`, so the insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_attendance_dashboard' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_attendance_dashboard' );

-- One row per designation that ALREADY holds `view_calculated_attendance`
-- and is active on it. `NOT EXISTS` makes the statement idempotent.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'view_attendance_dashboard', p.`designation_id`, TRUE
    FROM `permissions` p
   WHERE p.`permission_key` = 'view_calculated_attendance'
     AND p.`is_active` = TRUE
     AND NOT EXISTS (
       SELECT 1 FROM `permissions` q
        WHERE q.`permission_key` = 'view_attendance_dashboard'
          AND q.`designation_id` = p.`designation_id` )
   GROUP BY p.`designation_id`;
