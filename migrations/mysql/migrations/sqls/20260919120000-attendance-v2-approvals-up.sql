-- Attendance v2 / A3 - missing-punch regularization and OT approval.
--
-- ADDITIVE ONLY. Four new tables and five permission keys. No existing table
-- is altered and no existing grant is revoked.
--
-- THE RAW PUNCH IS NEVER EDITED. There is no UPDATE of `biomax_punch`
-- anywhere in this feature and no path that could produce one. An approved
-- manual punch is a row in `attendance_regularized_punch`, a different table
-- with its own source and its own audit trail, and the calculation for the
-- date is re-run from the raw punches PLUS that row. The device's record of
-- what it saw stays exactly as it arrived, which is what makes the regularized
-- punch reviewable at all.
--
-- ONLY A MISSING PUNCH MAY BE REGULARIZED. A request names the punch that is
-- absent; it cannot name an existing punch to replace, and `usecase/
-- attendance_regularization.js` refuses a request for a date whose punch count
-- is already even.
--
-- ONE DATE, ONE PASS. A date that has both a missing punch and resulting
-- overtime raises ONE request of type REGULARIZATION_WITH_OT, and the final
-- approval on that single chain approves both. OT with no missing punch is an
-- OT request and walks the same chain - approval is after the work, never
-- before it.
--
-- NOTHING IS PAYABLE UNTIL THE CHAIN FINISHES. A regularized punch joins the
-- effective punch list only when its request is APPROVED, and OT contributes
-- exactly zero until then. That is enforced in the usecase and asserted in
-- `usecase/attendance_regularization.test.js`, not left to a convention.

-- ============================================== 1. who approves for whom ===
-- Designation -> approval role. A MAPPING TABLE rather than hard-coded names,
-- because designations are free text in this database and a rename must not
-- silently break an approval chain.
--
-- SEEDED CONSERVATIVELY, AND DELIBERATELY INCOMPLETE. Only 'HR EXECUTIVE' is
-- mapped here, because it is the only designation name this codebase already
-- relies on by name (three earlier migrations grant to it). Store Manager,
-- Operations Manager and Head are NOT guessed from designation text: which
-- designations those are is a business fact nobody has recorded, and a
-- migration that guessed would be assigning approval authority in the one
-- place it could never be reviewed. An administrator maps them on the
-- designation screen, and until they do those stages are decidable only by an
-- administrator - visibly, as an override.
--
-- `requester_class` is separate from `approver_role` on purpose: being an
-- Operations Manager says which stage you may decide, and also which chain
-- YOUR OWN request follows, and they are not the same answer.
CREATE TABLE IF NOT EXISTS `attendance_approval_role` (
  `attendance_approval_role_id` INT NOT NULL AUTO_INCREMENT,
  `designation_id`  INT NOT NULL,
  `approver_role`   ENUM('STORE_MANAGER','OPERATIONS_MANAGER','HR','ADMIN') NULL
                    COMMENT 'which stage this designation may decide. NULL = decides nothing',
  `requester_class` ENUM('STORE_EMPLOYEE','MANAGER','HEAD') NOT NULL DEFAULT 'STORE_EMPLOYEE'
                    COMMENT 'which chain this designation own requests follow',
  `created_by` INT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_approval_role_id`),
  UNIQUE KEY `uq_aar_designation` (`designation_id`),
  CONSTRAINT `fk_aar_designation` FOREIGN KEY (`designation_id`)
    REFERENCES `designation` (`designation_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `attendance_approval_role` (`designation_id`, `approver_role`, `requester_class`)
  SELECT d.`designation_id`, 'HR', 'MANAGER'
    FROM `designation` d
   WHERE UPPER(TRIM(d.`designation_name`)) = 'HR EXECUTIVE'
     AND NOT EXISTS (
       SELECT 1 FROM `attendance_approval_role` a WHERE a.`designation_id` = d.`designation_id` );

-- ================================================ 2. the request itself ====
-- One row per (employee, attendance_date) that needs a human decision. The
-- unique key is on the OPEN request only - expressed as a generated column
-- that is the date while the request is PENDING and NULL once it is not - so
-- the same date can be regularized again after a rejection without ever having
-- two live requests at once.
CREATE TABLE IF NOT EXISTS `attendance_approval_request` (
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_type` ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT') NOT NULL,

  `requested_for_employee_id` INT  NOT NULL COMMENT 'whose attendance this is about',
  `requested_by_employee_id`  INT  NOT NULL COMMENT 'who raised it - may be a manager on their behalf',
  `attendance_date`           DATE NOT NULL,
  `outlet_id`                 INT NULL COMMENT 'the employee home outlet, for the Store Manager stage',
  `requester_class` ENUM('STORE_EMPLOYEE','MANAGER','HEAD') NOT NULL,

  `reason` VARCHAR(500) NOT NULL,

  -- what is being asked for. Both may be present on one request.
  `candidate_ot_minutes` INT NOT NULL DEFAULT 0 COMMENT 'as calculated at the time of raising',
  `approved_ot_minutes`  INT NULL COMMENT 'set on FINAL approval only',

  `status` ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `current_stage_no` INT NOT NULL DEFAULT 1,
  `total_stages`     INT NOT NULL,

  `created_at`  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `decided_at`  TIMESTAMP(3) NULL COMMENT 'when the chain finished, either way',
  `updated_at`  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  -- NULL unless PENDING, so the unique key below constrains open requests only.
  `open_attendance_date` DATE GENERATED ALWAYS AS
    (CASE WHEN `status` = 'PENDING' THEN `attendance_date` ELSE NULL END) STORED,

  PRIMARY KEY (`attendance_approval_request_id`),
  UNIQUE KEY `uq_aareq_open_per_employee_date`
    (`requested_for_employee_id`, `open_attendance_date`),
  KEY `idx_aareq_status_stage` (`status`, `current_stage_no`),
  KEY `idx_aareq_employee_date` (`requested_for_employee_id`, `attendance_date`),
  KEY `idx_aareq_outlet` (`outlet_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================== 3. the audit trail, full ===
-- One row per STAGE, written when the request is created so the whole chain is
-- visible while it is still pending - a requester can see that three people
-- have to agree, and which of them has not yet. Append-only in effect: a row
-- is written PENDING and stamped once with a decision, never re-decided.
CREATE TABLE IF NOT EXISTS `attendance_approval_step` (
  `attendance_approval_step_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `stage_no`      INT NOT NULL,
  `approver_role` ENUM('STORE_MANAGER','OPERATIONS_MANAGER','HR','ADMIN') NOT NULL,
  `outlet_id`     INT NULL COMMENT 'set on the STORE_MANAGER stage only - that role is outlet scoped',

  `decision` ENUM('PENDING','APPROVED','REJECTED','SKIPPED') NOT NULL DEFAULT 'PENDING',
  `decided_by_employee_id` INT NULL,
  `decided_at` TIMESTAMP(3) NULL,
  `remarks`    VARCHAR(500) NULL,
  `acted_as_admin_override` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = an administrator decided a stage they do not hold the role for',

  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`attendance_approval_step_id`),
  UNIQUE KEY `uq_aas_request_stage` (`attendance_approval_request_id`, `stage_no`),
  KEY `idx_aas_pending` (`decision`, `approver_role`),
  CONSTRAINT `fk_aas_request` FOREIGN KEY (`attendance_approval_request_id`)
    REFERENCES `attendance_approval_request` (`attendance_approval_request_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================== 4. the regularized punch itself =
-- The manual punch, stored SEPARATELY from the raw one and marked as what it
-- is, so the future display can say `Missed Punch - Regularized` without
-- having to infer it. It is written when the request is created and becomes
-- EFFECTIVE only when that request reaches APPROVED - the calculation joins on
-- the request status, so a pending punch changes no number.
--
-- The unique key is on the request, which is what stops a retried approval
-- from inserting the punch twice.
CREATE TABLE IF NOT EXISTS `attendance_regularized_punch` (
  `attendance_regularized_punch_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `employee_id`     INT  NOT NULL,
  `attendance_date` DATE NOT NULL,
  `punch_time`      DATETIME NOT NULL COMMENT 'IST wall clock, the same kind of value as biomax_punch.io_time',
  `punch_source`    ENUM('REGULARIZED') NOT NULL DEFAULT 'REGULARIZED',
  `created_by`      INT NOT NULL,
  `created_at`      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_regularized_punch_id`),
  UNIQUE KEY `uq_arp_request` (`attendance_approval_request_id`),
  KEY `idx_arp_employee_date` (`employee_id`, `attendance_date`),
  CONSTRAINT `fk_arp_request` FOREIGN KEY (`attendance_approval_request_id`)
    REFERENCES `attendance_approval_request` (`attendance_approval_request_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================================== permissions ====
--   raise_attendance_regularization  raise a request for yourself    HR EXECUTIVE
--   raise_attendance_regularization_for_others                       NOBODY
--   approve_attendance_regularization  decide a stage you hold       NOBODY
--   view_attendance_approvals        read the pending queue          HR EXECUTIVE
--   manage_attendance_approval_roles  map designations to roles      NOBODY (admin)
--
-- The two decision keys are granted to NOBODY by this migration. Approval
-- authority is the thing this feature exists to control; an administrator
-- grants it on the designation permissions screen, alongside mapping the
-- designations to roles in `attendance_approval_role`.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'raise_attendance_regularization' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'raise_attendance_regularization');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'raise_attendance_regularization_for_others' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'raise_attendance_regularization_for_others');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_attendance_regularization' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_attendance_regularization');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_attendance_approvals' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_attendance_approvals');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_attendance_approval_roles' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_approval_roles');

INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'raise_attendance_regularization' AS `permission_key`
           UNION ALL SELECT 'view_attendance_approvals' ) k
    JOIN ( SELECT `designation_id` FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE' ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );

-- ============================================================== report =====
-- REPORT ONLY. Which designations still have no approval role, so an
-- administrator can see exactly what is left to map before the chains work
-- without an administrator override.
SELECT d.`designation_name` AS `DESIGNATION_WITHOUT_APPROVAL_ROLE_map_on_designation_screen`
  FROM `designation` d
  LEFT JOIN `attendance_approval_role` a ON a.`designation_id` = d.`designation_id`
 WHERE a.`attendance_approval_role_id` IS NULL
 ORDER BY d.`designation_name`;
