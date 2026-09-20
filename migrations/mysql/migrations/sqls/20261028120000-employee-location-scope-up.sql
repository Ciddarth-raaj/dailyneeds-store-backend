-- DN-EMPLOYEE-LOCATION-SCOPE
--
-- One additive column, and the permission key that declares reading it.
-- Nothing existing is rewritten and no value moves.
--
-- ================================= 1. works_all_locations ================
--
-- WHY IT EXISTS. `new_employee.store_id` has always carried two facts at
-- once: which branch OWNS the record (authorization scope, the directory,
-- reporting lines) and where the person is EXPECTED TO STAND during their
-- shift (the staffing snapshot's Expected Now and Gap, per outlet). For an
-- area or operations role those are different places. Counting somebody
-- whose work is the whole chain into the Expected Now of the one outlet that
-- happens to hold their record - usually the warehouse - manufactures a
-- permanent staffing gap at a branch nobody was ever rostered to cover, and
-- reports every ordinary visit to another outlet as "recorded IN elsewhere -
-- verification needed".
--
-- DEFAULT 0, AND NOT NULL. Every employee who exists today is expected at
-- their own outlet, which is exactly what the column says about them after
-- this runs, and every employee created afterwards inherits the same answer
-- without Add Employee having to state it. NO ROW IS SET TO 1 BY THIS
-- MIGRATION: who roams is an operational decision for an administrator to
-- record per person, not something a schema change may assert on anybody's
-- behalf. In particular no name and no designation is named here or anywhere
-- in the code that reads this column.
--
-- WHAT IT DOES NOT MEAN. It is not an attendance exemption - that is
-- `attendance_required`, the column beside it, and the two are independent.
-- An employee with `works_all_locations = 1` still punches, still has a
-- shift, still appears in attendance, in the Missing Attendance Report and in
-- payroll. It is not a status, not a resignation and not a payroll switch.
-- `store_id` is NOT cleared for such an employee and must not be: every
-- branch authorization scope reads it, so blanking it would make the person
-- invisible to their own manager.
ALTER TABLE `new_employee`
  ADD COLUMN `works_all_locations` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1 = duty is not tied to one outlet (roaming / all locations); store_id remains the owning branch'
  AFTER `attendance_required`;

-- ============================================== 2. the view permission ===
--
-- VIEWING the flag is an ordinary employee-master read and is granted with
-- the profile. CHANGING it is administrators only and has NO permission key
-- on purpose, exactly as `attendance_required` is handled: a key is
-- grantable, and the requirement is that HR and Store Managers cannot hold
-- it. `middlewares/admin_only.js` enforces `user_type = 2` directly, which is
-- not grantable to anybody.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_employee_location_scope' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_employee_location_scope'
   );
