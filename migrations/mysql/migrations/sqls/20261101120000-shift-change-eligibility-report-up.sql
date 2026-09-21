-- SHIFT CHANGE ELIGIBILITY REPORT - TWO PERMISSION KEYS AND NOTHING ELSE.
--
-- NO TABLE IS CREATED, ALTERED, INDEXED OR WRITTEN by this migration. The
-- report derives every row it shows from data that already exists -
-- `new_employee`, the dated shift assignment and its overrides, `work_shift*`
-- and its configuration versions, `biomax_punch`, the stored
-- `attendance_day_calculation` and `attendance_approval_request` - and stores
-- none of them. `payrun_employee_calculation` is READ to find closed months
-- and is never written.
--
-- SO THERE IS NOTHING TO BACK FILL AND NOTHING TO RECALCULATE. Deploying this
-- migration cannot move an attendance figure, a payroll figure or a request,
-- and a closed payroll month is exactly as closed afterwards as before.
--
-- =========================================================== permissions ===
--
-- TWO KEYS, READ AND EXPORT, mirroring `view_missing_attendance_report` /
-- `export_missing_attendance_report` on the report next to it. Taking a
-- spreadsheet of every branch's long days off the premises is a different
-- decision from looking at the screen.
--
-- NEITHER IS A WRITE KEY. They gate a GET-only router. Raising a shift change
-- remains `raise_shift_change_request` on the employee's own route and
-- deciding one remains `approve_shift_change_request` on the approver's -
-- this report cannot reach either, and holding these keys grants neither.
--
-- GRANTED TO NOBODY. A cross-employee, cross-branch view of who may
-- regularise a long day is a capability rather than a convenience, and a
-- migration is the worst place to decide who has it: it would decide for
-- every designation at once, silently, at deploy time. Administrators
-- (`user_type` 2) reach it through the permission middleware's existing
-- bypass; anybody else is granted it deliberately, by a person, on the
-- Designation rights screen.
--
-- NEITHER KEY SETTLES WHICH BRANCHES. Holding the read key permits the
-- report; the caller's LOCATION scope is resolved separately by
-- `middlewares/dashboard_scope.js` and fails closed, so a branch manager
-- gains no visibility into another branch merely because this report exists.
--
-- `all_permissions` has no unique key on `permission_key`, so each insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_shift_change_eligibility_report' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_shift_change_eligibility_report' );

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'export_shift_change_eligibility_report' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'export_shift_change_eligibility_report' );
