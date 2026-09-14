-- DN-ATTENDANCE-EMPLOYEE-MASTER-FIXES
--
-- Four additive changes, none of which rewrites an existing value:
--
--   1. `new_employee.attendance_required` - biometric attendance is not
--      expected of everybody, and "exempt" is a different fact from
--      "resigned", "inactive" or "unpaid".
--   2. A REPAIR of the A0 shift-assignment history for the employees who
--      were created after that migration ran.
--   3. `employee_aadhaar_identity.name_as_per_aadhaar` - the verified legal
--      name, kept apart from the operational one, backfilled from the
--      verification payload that already holds it.
--   4. The declared permission key for VIEWING the attendance-required flag.
--      Changing it is administrators only and has no grantable key at all -
--      see `middlewares/admin_only.js`.

-- ============================================ 1. attendance_required =====
--
-- DEFAULT 1, and NOT NULL. Every employee who exists today requires
-- biometric attendance, which is exactly what the column says about them
-- after this runs, and every employee created after it inherits the same
-- answer without Add Employee having to state it.
--
-- WHAT IT DOES NOT MEAN. It is not a status, not a resignation and not a
-- payroll switch. An employee with `attendance_required = 0` is active,
-- payroll-eligible and paid; what changes is that the absence of a biometric
-- punch stops being evidence of anything. See `utils/attendance_payroll.js`.
ALTER TABLE `new_employee`
  ADD COLUMN `attendance_required` TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1 = biometric attendance is expected; 0 = exempt, still active and payroll-eligible'
  AFTER `special_break_override_minutes`;

-- ================================= 2. the shift-history repair backfill ==
--
-- WHY IT IS NEEDED. A0 created `employee_work_shift_assignment` and
-- backfilled one row per employee who had a `default_work_shift_id` AT THAT
-- MOMENT. Add Employee, however, writes `default_work_shift_id` on the
-- Employment stage and appended no history row, so every employee created
-- since that deploy reads as ASSIGNED on the Shift Assignment screen and
-- resolves to NO_SHIFT_FOR_DATE on every date in the Attendance Dashboard
-- and in payroll. The application side of that hole is closed in
-- `usecase/employee_master.js#createEmployee`; this closes the rows it has
-- already left behind.
--
-- THE EFFECTIVE DATE IS NOT A BLANKET CUTOVER, AND IT IS NEVER EARLIER THAN
-- ONE. A0 could only date its rows at the v2 cutover because nothing
-- recorded when those assignments were made. These employees do have such a
-- date - the day they joined - so the row is dated to:
--
--     GREATEST(2026-09-01, their joining date)
--
-- LATER of the two, both ways round, and each half is load-bearing:
--
--   * never before 2026-09-01, because that is the established v2 rule: no
--     dated history is invented before the cutover, the earliest date any
--     punch in this system can belong to and the date every work shift's
--     first configuration version is effective from. An employee who joined
--     in 2019 gets the cutover, exactly as A0 gave them.
--   * never before they joined, because a cutover-dated row for an October
--     joiner would assert they were rostered on a shift in September, a
--     month they were not employed.
--
-- So the date is always the more conservative of the two, and this can only
-- ever claim LESS history than A0's blanket cutover did - never more.
--
-- THE JOINING DATE IS READ THROUGH THE ONE SHARED PARSER. `date_of_joining`
-- is a VARCHAR holding three shapes - an ISO prefix sometimes followed by a
-- time, the Indian long form "05 September 2021", and (for most production
-- rows) nothing at all - and the CASE below is character-identical to
-- `JOINED_ON` in `utils/joining_date.js`, which the lifecycle backfill, the
-- dashboard and payroll already share. A bare STR_TO_DATE(..., '%Y-%m-%d')
-- would silently return NULL for two of those three shapes and quietly date
-- a genuine October joiner at the cutover.
--
-- An absent or unreadable joining date falls back to the cutover, which is
-- the A0 answer and the safe one: it claims no more than A0 already did.
--
-- WHY THIS CANNOT DAMAGE LEGITIMATE HISTORY. The guard is per EMPLOYEE and
-- not per row: an employee with ANY assignment row is skipped entirely, so
-- somebody who joined on Shift A in April and moved to Shift B in August
-- keeps both rows untouched and gains nothing. Only an employee with ZERO
-- rows is written to, and they receive exactly ONE - so no row is
-- overwritten, none is deleted, no duplicate is created, and one row cannot
-- overlap anything. A second run finds the row it wrote and inserts
-- nothing.
INSERT INTO `employee_work_shift_assignment`
       (`employee_id`, `work_shift_id`, `effective_from`, `source`, `note`, `created_by`)
  SELECT ne.`employee_id`,
         ne.`default_work_shift_id`,
         GREATEST(
           '2026-09-01',
           COALESCE(
             CASE
               WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
               WHEN ne.date_of_joining LIKE '____-__-__%'
                    AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                 THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
               ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
             END,
             '2026-09-01'
           )
         ),
         'MIGRATION_BACKFILL',
         'Repair: created with a default work shift but no dated history row',
         NULL
    FROM `new_employee` ne
   WHERE ne.`default_work_shift_id` IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM `employee_work_shift_assignment` a
        WHERE a.`employee_id` = ne.`employee_id` );

-- REPORT ONLY. Whoever runs the deploy sees whether the hole is closed.
SELECT COUNT(*) AS `EMPLOYEES_ASSIGNED_BUT_STILL_WITHOUT_DATED_HISTORY`
  FROM `new_employee` ne
 WHERE ne.`default_work_shift_id` IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM `employee_work_shift_assignment` a
      WHERE a.`employee_id` = ne.`employee_id` );

-- ============================================ 3. name as per Aadhaar =====
--
-- The verified legal name, on the identity row rather than on
-- `new_employee`, because that is where the rest of the verified identity
-- already lives and because it must not be reachable from the ordinary
-- employee-edit allowlist.
--
-- `new_employee.employee_name` keeps its present meaning exactly: the
-- OPERATIONAL name, editable, what every screen and report shows. The two
-- are deliberately different fields answering different questions, and
-- Employee Master offers a one-click copy between them rather than tying
-- them together.
ALTER TABLE `employee_aadhaar_identity`
  ADD COLUMN `name_as_per_aadhaar` VARCHAR(191) NULL
  COMMENT 'the name the Aadhaar verification returned, verbatim; never edited through Employee Master'
  AFTER `verified_at`;

-- The backfill reads the verification the identity was created from, which
-- already carries the payload. No new capture, and nothing is invented where
-- the verification has since been pruned or carried no name.
UPDATE `employee_aadhaar_identity` i
  JOIN `employee_aadhaar_verification` v ON v.`verification_id` = i.`verification_id`
   SET i.`name_as_per_aadhaar` =
       LEFT(TRIM(JSON_UNQUOTE(JSON_EXTRACT(v.`demographics_json`, '$.name'))), 191)
 WHERE i.`name_as_per_aadhaar` IS NULL
   AND v.`demographics_json` IS NOT NULL
   AND JSON_EXTRACT(v.`demographics_json`, '$.name') IS NOT NULL
   AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(v.`demographics_json`, '$.name'))) <> '';

SELECT COUNT(*) AS `AADHAAR_IDENTITIES_WITH_A_VERIFIED_NAME`
  FROM `employee_aadhaar_identity` WHERE `name_as_per_aadhaar` IS NOT NULL;

-- ============================================== 4. the view permission ===
--
-- VIEWING the flag is an ordinary employee-master read and is granted with
-- the profile. CHANGING it is administrators only and has NO permission key
-- on purpose: a key is grantable, and the requirement is that HR and Store
-- Managers cannot hold it. `middlewares/admin_only.js` enforces `user_type =
-- 2` directly, which is not grantable to anybody.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_attendance_required' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_attendance_required');
