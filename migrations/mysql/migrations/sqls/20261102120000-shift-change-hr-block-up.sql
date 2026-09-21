-- THE HR SHIFT CHANGE BLOCK - one new table and one permission key.
--
-- ADDITIVE ONLY. No existing table is altered, no column is added to one, no
-- index on one is changed and no row in one is written.
-- `attendance_approval_request` in particular is UNTOUCHED: a block is NOT a
-- request and must never be recorded as one. Writing a fake PENDING or
-- REJECTED row there would put a phantom into the approval queue, into the
-- one-open-request key, into every approver's list and into the report's
-- Request Status column - all to express something that is not a request at
-- all. `new_employee`, `biomax_punch`, `attendance_day_calculation`,
-- `employee_work_shift_assignment`, `work_shift*` and every payroll table are
-- likewise untouched.
--
-- NO BACKFILL. Nobody has been blocked, so the absence of a row IS the correct
-- starting state for every employee and every date.

-- ==================================================== the block ledger ======
--
-- ONE LIFECYCLE ROW PER BLOCK, and the row records its own removal rather than
-- being deleted. Block -> unblock -> block again is therefore two rows, both
-- permanent: the first carrying who blocked, why, when, and then who removed
-- it, why and when; the second carrying the fresh block. Nothing is ever
-- physically erased, so "was this date ever blocked, and by whom" is always
-- answerable - which is the whole point of writing it down.
--
-- THE ACTIVE-BLOCK INVARIANT IS THE INDEX'S, NOT THE CODE'S.
--
-- "Is this employee/date already blocked?" answered by a SELECT and acted on
-- by a later INSERT is a time-of-check to time-of-use race, and two HR users
-- on the same row would each pass the check. So `active_block` is GENERATED:
-- it is 1 while `removed_at IS NULL` and NULL once the block is removed, and
-- the UNIQUE key spans (employee_id, attendance_date, active_block). MySQL
-- allows duplicate NULLs in a unique index, so any number of REMOVED rows may
-- share an employee and date while at most ONE active row can exist.
--
-- THIS IS THE HOUSE CONVENTION, not an invention: `attendance_approval_request`
-- enforces one open request per employee/date with exactly this shape - a
-- generated column that is NULL unless the row is open, inside a unique key
-- (`uq_aareq_open_per_employee_date`). `attendance_missing_notification` uses
-- its unique key as the same kind of claim.
--
-- STORED, not VIRTUAL, because a generated column may only be indexed when it
-- is STORED in the MySQL versions this schema targets.
--
-- `outlet_id` IS A SNAPSHOT of where the employee was when the block was made,
-- kept for audit only. AUTHORIZATION NEVER READS IT: every block and unblock
-- re-resolves the employee's CURRENT `new_employee.store_id` on the server and
-- checks that against the actor's branch scope, so a transfer can never widen
-- or narrow who may act on the row afterwards.
--
-- THE ACTOR IS RECORDED TWICE - `..._by_employee_id` and `..._by_user_id` -
-- exactly as `attendance_punch_void` records a void. An account and a person
-- are not the same thing, and an audit that keeps only one of them cannot
-- answer the other question later.
--
-- `reason` AND `removal_reason` ARE MANDATORY IN THE USECASE and NOT NULL /
-- NULL here respectively: a block cannot exist without a reason, and a removal
-- reason exists only once a removal has happened.
CREATE TABLE IF NOT EXISTS `attendance_shift_change_block` (
  `attendance_shift_change_block_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`      INT  NOT NULL COMMENT 'new_employee.employee_id the block applies to',
  `attendance_date`  DATE NOT NULL COMMENT 'the ONE attendance date blocked',
  `outlet_id`        INT  NULL COMMENT 'snapshot of the employee store_id when blocked - audit only, never authorization',
  `reason`           VARCHAR(500) NOT NULL COMMENT 'mandatory, entered by the actor',
  `blocked_by_employee_id` INT NULL COMMENT 'new_employee.employee_id of the actor',
  `blocked_by_user_id`     INT NULL COMMENT 'user.user_id of the actor',
  `blocked_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `removed_by_employee_id` INT NULL,
  `removed_by_user_id`     INT NULL,
  `removed_at`       TIMESTAMP(3) NULL DEFAULT NULL COMMENT 'NULL while the block is ACTIVE',
  `removal_reason`   VARCHAR(500) NULL COMMENT 'mandatory when removing, NULL while active',
  `created_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `active_block`     TINYINT(1) GENERATED ALWAYS AS
    (CASE WHEN `removed_at` IS NULL THEN 1 ELSE NULL END) STORED
    COMMENT '1 while active, NULL once removed - the duplicate guard lives here',
  PRIMARY KEY (`attendance_shift_change_block_id`),
  UNIQUE KEY `uq_ascb_active_per_employee_date` (`employee_id`, `attendance_date`, `active_block`),
  KEY `idx_ascb_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_ascb_blocked_at` (`blocked_at`),
  CONSTRAINT `fk_ascb_employee` FOREIGN KEY (`employee_id`)
    REFERENCES `new_employee` (`employee_id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================================================== permission ====
--
-- ONE KEY, AND IT IS A WRITE KEY. `view_shift_change_eligibility_report` opens
-- the screen; it must NOT be what authorises changing somebody's eligibility.
-- Reading a list and removing a person's ability to regularise a day are
-- different decisions, and a designation can now be given the first without
-- the second.
--
-- GRANTED TO NOBODY. A migration is the worst place to decide who may block an
-- employee: it would decide for every designation at once, silently, at deploy
-- time. Administrators (`user_type` 2) reach it through the permission
-- middleware's existing bypass; anybody else is granted it deliberately, by a
-- person, on the Designation rights screen.
--
-- IT DOES NOT SETTLE WHICH BRANCHES. Holding this key permits the action; the
-- caller's branch scope is resolved separately by the existing employee
-- branch-scope convention and fails closed, so a branch manager granted this
-- key can block their own branch's employees and nobody else's.
--
-- `all_permissions` has no unique key on `permission_key`, so the insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_shift_change_eligibility' FROM DUAL
   WHERE NOT EXISTS (
     SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_shift_change_eligibility' );
