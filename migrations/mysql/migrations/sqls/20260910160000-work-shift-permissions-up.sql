-- The Work Shift system's own permission keys.
--
-- Phase 1 shipped /work-shift and Employee Shift Assignment behind the LEGACY
-- shift master's keys, `view_shift` and `add_shifts`, on the reasoning that
-- whoever maintains shifts maintains work shifts. That is not true in this
-- database: `view_shift` is granted to designations with no payroll role at
-- all - Operations holds it - so the roster and the employee -> shift mapping
-- are currently visible to people who were never meant to see them.
--
-- These five keys replace it. They are granted to HR EXECUTIVE and to nobody
-- else; administrators need no grant because the permission middleware
-- bypasses this table entirely for `user_type = 2`.
--
--   view_work_shifts            read the work shift master and its schedules
--   manage_work_shifts          create, edit, activate/deactivate a shift
--   view_shift_assignments      read who is on which shift
--   assign_employee_shift       move ONE employee onto a shift
--   bulk_assign_employee_shift  move MANY in one action
--
-- NO TABLE, COLUMN OR EMPLOYEE ROW IS TOUCHED. This migration declares five
-- keys and writes five grant rows for one designation. It is additive: it
-- revokes nothing and deletes nothing, including the now-unused pairing of
-- `view_shift` with the work shift screens, which stops mattering the moment
-- the routes stop asking for it.
--
-- THE LEGACY /shift SCREENS ARE UNCHANGED and keep `view_shift` /
-- `add_shifts`. Whoever can open them today still can.

-- ------------------------------------------------------------ declarations
-- `all_permissions` has no unique key on permission_key, so each insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_work_shifts' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_work_shifts');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_work_shifts' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_work_shifts');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_shift_assignments' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_shift_assignments');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'assign_employee_shift' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'assign_employee_shift');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'bulk_assign_employee_shift' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'bulk_assign_employee_shift');

-- ------------------------------------------------------------------ grants
-- HR EXECUTIVE AND NOBODY ELSE.
--
-- NOT derived from `view_shift` or `add_shifts`: deriving from the key this
-- change exists to stop trusting would reproduce exactly the access it is
-- meant to withdraw.
--
-- Named by `designation.designation_name`, not by a literal id, because ids
-- differ between the production schema and any restored copy and a hard-coded
-- one would grant these to whatever designation happened to hold that number.
-- The comparison is case- and whitespace-insensitive because the row was
-- typed by a human. If no such designation exists the join matches nothing
-- and NOTHING IS GRANTED - the failure mode is "the feature is unavailable
-- until an administrator grants it", never "the wrong people can run it".
--
-- Any OTHER designation that should hold these - a second HR designation
-- under a different name, say - is an administrator's decision, made on the
-- designation permissions screen where these five keys now appear.
--
-- Each insert is guarded on (permission_key, designation_id) because
-- `permissions` has no unique key either, so a re-run adds nothing. A row
-- that exists but is INACTIVE is left alone: re-enabling a permission an
-- administrator switched off is their decision, not a migration's.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'view_work_shifts' AS `permission_key`
           UNION ALL SELECT 'manage_work_shifts'
           UNION ALL SELECT 'view_shift_assignments'
           UNION ALL SELECT 'assign_employee_shift'
           UNION ALL SELECT 'bulk_assign_employee_shift' ) k
    JOIN ( SELECT `designation_id` FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE' ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );

-- The employee-master half of each assignment check - `view_employees` for
-- the reads, `employee_edit` for the writes - is NOT granted here. Those keys
-- gate the employee directory, this migration is about work shifts, and
-- handing out employee access as a side effect of a shift change is exactly
-- the kind of quiet widening the five keys above exist to end. Whoever
-- assigns shifts already holds them, or an administrator grants them
-- deliberately.
