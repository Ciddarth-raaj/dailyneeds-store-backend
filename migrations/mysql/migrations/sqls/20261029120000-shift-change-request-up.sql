-- SHIFT ASSIGNMENT HISTORY + THE ONE-DAY SHIFT CHANGE REQUEST.
--
-- ADDITIVE. No table is created that duplicates one that exists, no row is
-- rewritten and no permission is revoked. Every concept this feature needs
-- already has a home:
--
--   the effective-dated permanent shift   `employee_work_shift_assignment`
--   the one-date shift                    `attendance_date_shift_override`
--   the request and its approval chain    `attendance_approval_request`
--                                         `attendance_approval_step`
--
-- so what follows extends those four and adds nothing beside them.

-- ===================================================== 1. the pay figures ==
-- THE BASE NRM IS NOT THE DAY'S NRM on a date carrying an approved one-day
-- override. The shift the date was CALCULATED under decides the expected
-- hours, the lunch and break rules, the late and early-going flags and the
-- missing-punch expectation; the employee's PERMANENT shift decides what they
-- are entitled to be paid as regular time. An employee whose permanent shift
-- is 6pm-10pm and who is approved to work 10am-10pm for one Saturday is owed
-- 4h regular and 6h overtime, not 10h regular - and, working only 3h, is 1h
-- short rather than 7h short. Both numbers are therefore stored on the row:
-- deriving either afterwards would mean re-resolving the history from a
-- payslip query.
ALTER TABLE `attendance_day_calculation`
  ADD COLUMN `base_nrm_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'the PERMANENT shift NRM for the date - what regular, OT and shortage are measured against'
    AFTER `nrm_minutes`,
  ADD COLUMN `base_work_shift_id` INT NULL
    COMMENT 'the permanent shift the base NRM came from. NULL = the same shift as the day itself'
    AFTER `base_nrm_minutes`,
  ADD COLUMN `regular_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'MIN(worked_minutes, base_nrm_minutes)'
    AFTER `worked_minutes`;

-- =============================================== 2. the permanent history ==
-- A new `source`. An effective-dated shift CHANGE is neither an ordinary
-- assignment (which is always dated today) nor a CORRECTION (which says a
-- past record was wrong): it says the roster changes from a stated date,
-- which may be in the past or the future. Recording it as its own source
-- keeps the three distinguishable for ever after.
ALTER TABLE `employee_work_shift_assignment`
  MODIFY COLUMN `source`
    ENUM('MIGRATION_BACKFILL','ASSIGNMENT','BULK_ASSIGNMENT','CORRECTION','SHIFT_CHANGE') NOT NULL,
  MODIFY COLUMN `note` VARCHAR(500) NULL
    COMMENT 'the reason, mandatory on a SHIFT_CHANGE and on a CORRECTION';

-- ================================================= 3. the request itself ===
-- SHIFT_CHANGE joins the enum rather than getting a table of its own: it is
-- the same shape of thing as the two that are there - one employee, one date,
-- one reason, one approval chain, one audit trail - and a parallel request
-- table would mean a parallel chain, a parallel queue and a second place the
-- payroll lock has to be remembered.
ALTER TABLE `attendance_approval_request`
  MODIFY COLUMN `request_type`
    ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE') NOT NULL,
  ADD COLUMN `requested_work_shift_id` INT NULL
    COMMENT 'SHIFT_CHANGE only: the shift asked for, for that ONE date',
  ADD COLUMN `base_work_shift_id` INT NULL
    COMMENT 'SHIFT_CHANGE only: the permanent shift as resolved when the request was raised',
  ADD COLUMN `telegram_chat_id` BIGINT NULL
    COMMENT 'the chat the FIRST approver was messaged in - nobody else is messaged',
  ADD COLUMN `telegram_message_id` BIGINT NULL
    COMMENT 'that message, so its buttons can be retired once the request is actioned',
  ADD KEY `idx_aareq_requested_shift` (`requested_work_shift_id`);

-- THE OPEN-REQUEST KEY, WIDENED BY ONE CONCEPT AND NOT BY MORE.
--
-- `uq_aareq_open_per_employee_date` allowed exactly ONE open request per
-- employee per date, of any type. That is right for attendance and OT, which
-- are two claims about the same punched day and must not race each other. It
-- is wrong for a shift request, which is normally raised BEFORE the date is
-- worked at all: a pending request to work Saturday on another shift would
-- otherwise block the OT claim that Saturday's work earns.
--
-- So the key gains a GROUP, not a type: SHIFT stands apart, and REGULARIZATION
-- and OT stay in one group exactly as they are today. Two shift requests for
-- one date still cannot both be open, which is the duplicate-override
-- protection the approved task asks for, enforced by the database rather than
-- by a check anybody could forget.
ALTER TABLE `attendance_approval_request`
  ADD COLUMN `open_request_group` ENUM('ATT','SHIFT') GENERATED ALWAYS AS
    (CASE WHEN `status` = 'PENDING'
          THEN (CASE WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT' ELSE 'ATT' END)
          ELSE NULL END) STORED,
  DROP INDEX `uq_aareq_open_per_employee_date`,
  ADD UNIQUE KEY `uq_aareq_open_per_employee_date`
    (`requested_for_employee_id`, `open_attendance_date`, `open_request_group`);

-- ===================================================== 4. WHO decided, HOW ==
-- Telegram and the web app act on the SAME request record through the same
-- decision path; this column is the only difference between them, and it is
-- recorded because "who approved this, and from where" is an audit question
-- that cannot be answered later from anything else.
ALTER TABLE `attendance_approval_step`
  ADD COLUMN `decision_source` ENUM('WEB','TELEGRAM') NULL
    COMMENT 'where the decision was taken. NULL on a step that has not been decided'
    AFTER `decided_at`;

-- ======================================== 5. the override, given a reason ===
-- An approved request writes through the EXISTING override table - the same
-- table the direct single-date edit writes, read by the same resolver, with
-- the same precedence over the dated history. What is added is the link back
-- to the request that authorized it, so an override can always name its
-- authority, and `source`, so a management edit and an approved employee
-- request are distinguishable without joining.
ALTER TABLE `attendance_date_shift_override`
  ADD COLUMN `attendance_approval_request_id` BIGINT UNSIGNED NULL
    COMMENT 'the SHIFT_CHANGE request this override was written by. NULL = a direct management edit',
  ADD COLUMN `source` ENUM('DIRECT','APPROVED_REQUEST') NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN `reason` VARCHAR(500) NULL,
  ADD KEY `idx_adso_request` (`attendance_approval_request_id`);

-- ========================================================== permissions ====
--   edit_shift_assignment_effective_dated  change somebody's PERMANENT shift
--                                          from a stated date          NOBODY
--   raise_shift_change_request             ask for another shift on ONE date,
--                                          for YOURSELF only           NOBODY
--   approve_shift_change_request           reach the shift decision endpoint
--                                                                      NOBODY
--   view_shift_change_requests             see the Shift tab of the approval
--                                          centre                      NOBODY
--
-- Granted to nobody by this migration, like every other key in this feature:
-- changing the shift a date is calculated under changes that date's NRM, its
-- shortage and its overtime, and so its pay. Administrators reach these
-- through the user_type 2 bypass; anybody else is given them deliberately on
-- the designation rights screen. Note that `approve_shift_change_request` is
-- the key to the ENDPOINT and not the authority to decide a stage - that is
-- `utils/attendance_approval_chain.js#canApprove`, exactly as for the other
-- two request types.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_shift_assignment_effective_dated' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_shift_assignment_effective_dated');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'raise_shift_change_request' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'raise_shift_change_request');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_shift_change_request' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_shift_change_request');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_shift_change_requests' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_shift_change_requests');
