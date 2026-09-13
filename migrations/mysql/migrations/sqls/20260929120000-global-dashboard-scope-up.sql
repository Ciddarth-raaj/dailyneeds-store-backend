-- GLOBAL DASHBOARD ACCESS - the dashboard feature keys and the store scope.
--
-- ADDITIVE AND PERMISSION-ONLY. It creates no table, alters no table, adds no
-- column or index, and touches no employee, attendance, shift, punch, salary or
-- payroll data. Every statement guards itself, so a re-run adds nothing.
--
-- IT GRANTS NOTHING TO ANYBODY. Not one designation receives any key here.
-- That is deliberate and is the same decision the Attendance Dashboard
-- migration made: who may see which branches is an authorization decision for
-- a person on the rights screen, and a migration is the worst possible place to
-- make it, because it makes it for every designation at once, silently, at
-- deploy time. A dashboard with no scope granted refuses - fail closed - which
-- is the correct state until somebody configures it.
--
-- ============================================ WHY A NEW MIGRATION ===========
--
-- `20260928120000-attendance-dashboard-permission` is left exactly as it is.
-- It may already have run in another environment, and rewriting a migration
-- that has run somewhere is how two environments quietly stop matching. This
-- one is purely additive beside it.
--
-- ============================================ THE TWO KINDS OF KEY ==========
--
-- FEATURE KEYS - one per dashboard. Each says "this person may open this
-- screen" and nothing whatever about locations:
--
--   view_attendance_dashboard   already declared by the earlier migration
--   view_hr_dashboard           declared here, no route yet
--   view_sales_dashboard        declared here, no route yet
--   view_my_dashboard           declared here, no route yet
--
-- The three new ones build no screen, add no route and put nothing in the
-- navigation. They exist so the shared resolver has a complete vocabulary and a
-- future module can be gated without inventing an authorization scheme of its
-- own. Declaring a key that nobody holds costs nothing and changes no
-- behaviour; a dead menu entry would, which is why there is none.
--
-- SCOPE KEYS - shared by every dashboard, and EXACTLY ONE is meant to apply:
--
--   dashboard_scope_own_store   only the branch Employee Master assigns them
--   dashboard_scope_all_stores  every branch
--
-- THE APPROVED MODEL IS ONE VALUE, and an enum would express it better. This
-- rights system has no enum: `permissions` is (designation_id, permission_key,
-- is_active) and every right in the application is a boolean key read through
-- one cached lookup. So the approved fallback applies - two keys, with exactly
-- one effective scope ENFORCED ON THE SERVER by `utils/dashboard_scope.js`.
-- A designation holding both is a configuration fault and is REFUSED rather
-- than resolved to either one: guessing would turn a mis-click into
-- company-wide attendance access. Administrators are decided by `user_type`
-- before that rule, since they hold every key by definition.
--
-- ===================================== THE EXISTING `all_stores` KEY ========
--
-- IT IS NOT REUSED, AND NOT TOUCHED. `all_stores` ("Access All Stores") is an
-- application-wide permission with its own established meaning: the web app's
-- `UserContext` nulls the signed-in user's store for anybody holding it, which
-- changes how operational screens outside the dashboards behave. Borrowing it
-- as a dashboard scope would tie two unrelated capabilities together in both
-- directions - granting dashboard reach to everyone who has it today, and
-- forcing anyone who needs company-wide dashboards to also take an
-- application-wide store change they may not want.
--
-- So dashboard scope is explicit and its own. Existing `all_stores` holders are
-- NOT migrated to a dashboard scope automatically. Nobody loses working access
-- by this: `view_attendance_dashboard` is granted to no designation, so no
-- non-administrator can open a dashboard today, and there is no live behaviour
-- to preserve. Anybody who should have company-wide dashboards is granted
-- `dashboard_scope_all_stores` explicitly, by a person, on the rights screen.
--
-- `all_permissions` has no unique key on `permission_key`, so every insert
-- guards itself and a re-run adds nothing.

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_hr_dashboard' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_hr_dashboard' );

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_sales_dashboard' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_sales_dashboard' );

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_my_dashboard' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_my_dashboard' );

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'dashboard_scope_own_store' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'dashboard_scope_own_store' );

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'dashboard_scope_all_stores' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'dashboard_scope_all_stores' );
