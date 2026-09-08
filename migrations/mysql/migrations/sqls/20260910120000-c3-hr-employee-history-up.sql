-- Stage 0C / C3 — the HR Employee Master becomes history-owned.
--
-- ADDITIVE ONLY. No employee row, employee ID, lifecycle period, Aadhaar
-- record or bank verification is written, altered or deleted by this file.
-- No projection column is dropped: `new_employee.store_id`,
-- `department_id`, `designation_id`, `shift_id`, `salary` and
-- `payment_type` all stay exactly where they are and keep their current
-- values. They become COMPATIBILITY PROJECTIONS of the history introduced
-- here, not a second source of truth.
--
-- Every statement is guarded so the whole file can be re-run without error,
-- because a migration that cannot be re-run is one that cannot be recovered
-- halfway through - which is exactly when it matters.
--
-- ============================================================ THE MODEL ==
--
-- Three separate effective-dated histories, deliberately NOT collapsed into
-- one, because they change for different reasons and at different times:
--
--   employee_assignment              branch, department, designation
--   employee_default_shift_history   the employee's default shift
--   employee_salary_history          the salary master
--
-- All three share one interval convention, and it is half-open:
--
--       [effective_from, effective_to)
--
--   effective_from  inclusive - the first date the row applies
--   effective_to    EXCLUSIVE - the first date it no longer applies
--   effective_to IS NULL  the row is current
--
-- So a Cashier who became a Supervisor on 01-Sep-2026 is:
--
--       Cashier      [2026-01-01, 2026-09-01)
--       Supervisor   [2026-09-01, NULL)
--
-- and 01-Sep belongs to exactly one row. "Last covered date" semantics are
-- never used: they make every boundary an off-by-one argument, and they make
-- a one-day assignment indistinguishable from a zero-day one.
--
-- DATE, not DATETIME. These are business facts about days, not instants. A
-- transfer happens on a date; it does not happen at 14:32:07. `created_at`
-- and the review timestamps remain TIMESTAMP, because those record when the
-- SYSTEM learned something, which is a different question from when the fact
-- applied.
--
-- ------------------------------------------------- one open row, in the DB
-- MySQL has no partial unique index, so "at most one open row per employment
-- period" cannot be written as WHERE effective_to IS NULL. The established
-- idiom in this schema - see `employee_employment_period.open_marker` from
-- C1 - is a STORED generated column that carries the key only while the row
-- is open, and NULL otherwise. A unique index over it then enforces the rule,
-- because MySQL permits many NULLs in a unique index.
--
--     open_marker = CASE WHEN effective_to IS NULL AND voided_at IS NULL
--                        THEN period_id ELSE NULL END
--
-- Keying it on `period_id` rather than a literal 1 gives one open row PER
-- EMPLOYMENT PERIOD, which is the actual invariant: a rejoined employee's
-- new period gets its own current assignment without colliding with the
-- closed one from before they left.
--
-- Service logic enforces the same rule first, with a better error message.
-- The index is what makes it true under concurrency.

-- ================================================== 1. the cutover state ==
-- The state is OWNED BY THE DATABASE, not by an environment variable, a PM2
-- setting or a frontend flag. Those do not survive a restart the way a fact
-- about production data must, and two application processes reading two
-- different .env files would disagree about whether history is authoritative.
--
-- One row, forced by a primary key on a constant.
CREATE TABLE IF NOT EXISTS `hr_cutover_state` (
  `id`                          TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `state`                       ENUM('PREPARING_BASELINE','BASELINE_VALIDATED','HISTORY_ACTIVE')
                                NOT NULL DEFAULT 'PREPARING_BASELINE',
  -- The operative boundary for baseline rows and for the pre-go-live query
  -- rule. Set when the baseline is validated; never a claim that anything
  -- changed on this date.
  `go_live_date`                DATE NULL DEFAULT NULL,
  `baseline_batch_id`           BIGINT UNSIGNED NULL DEFAULT NULL,
  -- Activation evidence. Recorded because an irreversible operation with no
  -- named actor is not an audit trail.
  `activated_by_employee_id`    INT NULL DEFAULT NULL,
  `activated_at`                TIMESTAMP NULL DEFAULT NULL,
  `backup_reference`            VARCHAR(255) NULL DEFAULT NULL,
  `backup_taken_at`             TIMESTAMP NULL DEFAULT NULL,
  `mapping_review_completed_at` TIMESTAMP NULL DEFAULT NULL,
  `salary_review_completed_at`  TIMESTAMP NULL DEFAULT NULL,
  `note`                        VARCHAR(500) NULL DEFAULT NULL,
  `updated_at`                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_hr_cutover_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seeded to the live-today behaviour: legacy edits keep working exactly as
-- they do now until somebody deliberately advances the state.
INSERT INTO `hr_cutover_state` (`id`, `state`)
  SELECT 1, 'PREPARING_BASELINE' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `hr_cutover_state` WHERE `id` = 1);

-- ============================================ 2. the finalized-history lock
-- Nullable, and NULL today. Attendance and Payroll will later advance it as
-- they finalize months; every history-aware write checks it from the first
-- implementation so that the check is proven long before anything depends on
-- it. Owned by the employment period, because that is what history belongs to.
SET @add_lock = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_employment_period'
      AND `COLUMN_NAME` = 'history_locked_through') = 0,
  'ALTER TABLE `employee_employment_period` ADD COLUMN `history_locked_through` DATE NULL DEFAULT NULL AFTER `needs_review`',
  'DO 0');
PREPARE s FROM @add_lock; EXECUTE s; DEALLOCATE PREPARE s;

-- ================================================= 3. the two hierarchies ==
-- Department and Designation become trees. Both already carry `status`,
-- which is the existing active/inactive flag - a second one would be a second
-- answer to the same question - so only the parent link is added.
--
-- Cycles and self-parenting are refused by the service: MySQL cannot express
-- "no cycles" as a constraint, and a trigger doing recursive lookups on every
-- write is worse than a checked write path plus an invariant that detects it.
SET @add_dept_parent = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'department'
      AND `COLUMN_NAME` = 'parent_department_id') = 0,
  'ALTER TABLE `department` ADD COLUMN `parent_department_id` INT NULL DEFAULT NULL',
  'DO 0');
PREPARE s FROM @add_dept_parent; EXECUTE s; DEALLOCATE PREPARE s;

SET @add_dept_idx = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'department'
      AND `INDEX_NAME` = 'idx_department_parent') = 0,
  'ALTER TABLE `department` ADD KEY `idx_department_parent` (`parent_department_id`)',
  'DO 0');
PREPARE s FROM @add_dept_idx; EXECUTE s; DEALLOCATE PREPARE s;

SET @add_desig_parent = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'designation'
      AND `COLUMN_NAME` = 'parent_designation_id') = 0,
  'ALTER TABLE `designation` ADD COLUMN `parent_designation_id` INT NULL DEFAULT NULL',
  'DO 0');
PREPARE s FROM @add_desig_parent; EXECUTE s; DEALLOCATE PREPARE s;

SET @add_desig_idx = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'designation'
      AND `INDEX_NAME` = 'idx_designation_parent') = 0,
  'ALTER TABLE `designation` ADD KEY `idx_designation_parent` (`parent_designation_id`)',
  'DO 0');
PREPARE s FROM @add_desig_idx; EXECUTE s; DEALLOCATE PREPARE s;

-- ======================================= 4. Department <-> Designation map
-- Which designations may be held in which department. EXPLICIT: a mapping on
-- a parent department does NOT apply to its children, because "Sales allows
-- Cashier" says nothing about whether the new "Front End" sub-department
-- does. The UI may offer to copy a parent's mappings; that writes real rows.
--
-- `review_state` exists because the legacy data cannot simply be promoted
-- into company policy - some of the combinations in it are mistakes. Every
-- distinct combination held by an active employee must be APPROVED (or the
-- affected employees corrected) before the baseline can validate.
CREATE TABLE IF NOT EXISTS `department_designation_map` (
  `map_id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `department_id`            INT NOT NULL,
  `designation_id`           INT NOT NULL,
  `is_active`                TINYINT(1) NOT NULL DEFAULT 1,
  `review_state`             ENUM('NEEDS_REVIEW','APPROVED','REJECTED') NOT NULL DEFAULT 'NEEDS_REVIEW',
  `observed_employee_count`  INT NOT NULL DEFAULT 0
                             COMMENT 'active employees seen on this combination when it was discovered',
  `reviewed_by_employee_id`  INT NULL DEFAULT NULL,
  `reviewed_at`              TIMESTAMP NULL DEFAULT NULL,
  `review_note`              VARCHAR(500) NULL DEFAULT NULL,
  `source`                   ENUM('BASELINE_DISCOVERY','HR_UI','COPIED_FROM_PARENT') NOT NULL DEFAULT 'HR_UI',
  `created_by_employee_id`   INT NULL DEFAULT NULL,
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`map_id`),
  UNIQUE KEY `uq_dept_designation` (`department_id`, `designation_id`),
  KEY `idx_map_review` (`review_state`),
  KEY `idx_map_designation` (`designation_id`),
  CONSTRAINT `fk_map_department` FOREIGN KEY (`department_id`)
    REFERENCES `department` (`department_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_map_designation` FOREIGN KEY (`designation_id`)
    REFERENCES `designation` (`designation_id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ==================================================== 5. Assignment history
-- Branch, department and designation, effective-dated and REPLACE-ONLY.
--
-- Once history is active these three stop being editable employee columns
-- entirely: a transfer or a promotion closes the current row and opens a new
-- one, and `new_employee` is updated to match as a projection. Changing the
-- column directly would be a change with no date, no reason and no evidence.
CREATE TABLE IF NOT EXISTS `employee_assignment` (
  `assignment_id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`                INT NOT NULL,
  `period_id`                  BIGINT UNSIGNED NOT NULL,

  -- The permanent/home outlet. NOT the outlet somebody is temporarily
  -- covering: temporary deployment is not an HR transfer and has no record
  -- here by design (see docs; Attendance will own actual worked location).
  `outlet_id`                  INT NOT NULL,
  `department_id`              INT NOT NULL,
  `designation_id`             INT NOT NULL,

  `effective_from`             DATE NOT NULL,
  `effective_to`               DATE NULL DEFAULT NULL,
  -- KNOWN            the date is a real business fact
  -- UNKNOWN_BASELINE the row records what is true NOW; the date it began is
  --                  not known, and the go-live date is used as an operative
  --                  boundary rather than a claim
  `effective_from_precision`   ENUM('KNOWN','UNKNOWN_BASELINE') NOT NULL DEFAULT 'KNOWN',

  `change_type`                ENUM('INITIAL_ASSIGNMENT','BASELINE_IMPORT','TRANSFER','PROMOTION',
                                    'DEMOTION','DEPARTMENT_CHANGE','ROLE_CHANGE','REASSIGNMENT',
                                    'REJOIN_ASSIGNMENT','CORRECTION') NOT NULL,
  `reason`                     VARCHAR(500) NULL DEFAULT NULL,
  `source`                     ENUM('HR_UI','BULK','LEGACY_VERIFIED_BASELINE','SYSTEM')
                               NOT NULL DEFAULT 'HR_UI',

  `created_by_employee_id`     INT NULL DEFAULT NULL,
  -- When the SYSTEM learned the fact. Never implies the fact applied then;
  -- a backdated transfer has an earlier effective_from and a later created_at,
  -- and both are true.
  `created_at`                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Correction, not deletion. The erroneous row stays, marked, and points at
  -- what replaced it - a mistyped branch must not become a fake transfer.
  `voided_at`                  TIMESTAMP NULL DEFAULT NULL,
  `voided_by_employee_id`      INT NULL DEFAULT NULL,
  `correction_of_assignment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `superseded_by_assignment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `correction_reason`          VARCHAR(500) NULL DEFAULT NULL,

  `open_marker`                BIGINT UNSIGNED GENERATED ALWAYS AS
                                 (CASE WHEN `effective_to` IS NULL AND `voided_at` IS NULL
                                       THEN `period_id` ELSE NULL END) STORED,

  PRIMARY KEY (`assignment_id`),
  UNIQUE KEY `uq_assignment_one_open` (`open_marker`),
  KEY `idx_assignment_employee` (`employee_id`, `effective_from`),
  KEY `idx_assignment_period` (`period_id`, `effective_from`),
  KEY `idx_assignment_outlet` (`outlet_id`),
  KEY `idx_assignment_department` (`department_id`),
  KEY `idx_assignment_designation` (`designation_id`),
  CONSTRAINT `fk_assignment_employee` FOREIGN KEY (`employee_id`)
    REFERENCES `new_employee` (`employee_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_assignment_period` FOREIGN KEY (`period_id`)
    REFERENCES `employee_employment_period` (`period_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Zero-length and inverted intervals are impossible, not merely refused by
  -- the service. `effective_to` is exclusive, so equal dates cover no days.
  CONSTRAINT `chk_assignment_interval` CHECK (`effective_to` IS NULL OR `effective_to` > `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================================= 6. Default Shift history
-- Separate from Assignment: a shift change is not a transfer, and collapsing
-- them would force one to invent a value whenever only the other changed.
--
-- Genuinely optional. An employee may never have had a default shift, and
-- zero rows is a valid, complete answer - unlike Assignment, which every
-- active period must have.
CREATE TABLE IF NOT EXISTS `employee_default_shift_history` (
  `shift_history_id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`                INT NOT NULL,
  `period_id`                  BIGINT UNSIGNED NOT NULL,
  `shift_id`                   INT NOT NULL,

  `effective_from`             DATE NOT NULL,
  `effective_to`               DATE NULL DEFAULT NULL,
  `effective_from_precision`   ENUM('KNOWN','UNKNOWN_BASELINE') NOT NULL DEFAULT 'KNOWN',

  `change_type`                ENUM('INITIAL_SHIFT','BASELINE_IMPORT','SHIFT_CHANGE',
                                    'REJOIN_SHIFT','CORRECTION') NOT NULL,
  `reason`                     VARCHAR(500) NULL DEFAULT NULL,
  `source`                     ENUM('HR_UI','BULK','LEGACY_VERIFIED_BASELINE','SYSTEM')
                               NOT NULL DEFAULT 'HR_UI',

  `created_by_employee_id`     INT NULL DEFAULT NULL,
  `created_at`                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  `voided_at`                  TIMESTAMP NULL DEFAULT NULL,
  `voided_by_employee_id`      INT NULL DEFAULT NULL,
  `correction_of_shift_history_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `superseded_by_shift_history_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `correction_reason`          VARCHAR(500) NULL DEFAULT NULL,

  `open_marker`                BIGINT UNSIGNED GENERATED ALWAYS AS
                                 (CASE WHEN `effective_to` IS NULL AND `voided_at` IS NULL
                                       THEN `period_id` ELSE NULL END) STORED,

  PRIMARY KEY (`shift_history_id`),
  UNIQUE KEY `uq_shift_one_open` (`open_marker`),
  KEY `idx_shift_hist_employee` (`employee_id`, `effective_from`),
  KEY `idx_shift_hist_period` (`period_id`, `effective_from`),
  KEY `idx_shift_hist_shift` (`shift_id`),
  CONSTRAINT `fk_shift_hist_employee` FOREIGN KEY (`employee_id`)
    REFERENCES `new_employee` (`employee_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_shift_hist_period` FOREIGN KEY (`period_id`)
    REFERENCES `employee_employment_period` (`period_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_shift_hist_interval` CHECK (`effective_to` IS NULL OR `effective_to` > `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===================================================== 7. Salary history ==
-- The salary MASTER - what the employee is engaged at. Payroll calculates
-- monthly pay from it later, in its own module; nothing here computes money.
--
-- `salary` is DECIMAL(12,2) here even though the legacy projection column is
-- VARCHAR(45). That is deliberate: the history is the authoritative record
-- and deserves a numeric type, and the comparison between the two is exactly
-- why governed-field normalization has to be decimal-aware rather than
-- string equality. `payment_type` stays VARCHAR(45) to match the projection
-- exactly, because inventing an ENUM would silently reject legacy values
-- nobody has audited yet.
CREATE TABLE IF NOT EXISTS `employee_salary_history` (
  `salary_history_id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`                INT NOT NULL,
  `period_id`                  BIGINT UNSIGNED NOT NULL,

  `salary`                     DECIMAL(12,2) NOT NULL,
  `payment_type`               VARCHAR(45) NULL DEFAULT NULL,

  `effective_from`             DATE NOT NULL,
  `effective_to`               DATE NULL DEFAULT NULL,
  `effective_from_precision`   ENUM('KNOWN','UNKNOWN_BASELINE') NOT NULL DEFAULT 'KNOWN',

  `revision_type`              ENUM('INITIAL_SALARY','BASELINE_IMPORT','REVISION',
                                    'PROMOTION_REVISION','REJOIN_SALARY','CORRECTION') NOT NULL,
  `reason`                     VARCHAR(500) NULL DEFAULT NULL,
  `source`                     ENUM('HR_UI','BULK','LEGACY_VERIFIED_BASELINE','SYSTEM')
                               NOT NULL DEFAULT 'HR_UI',

  `created_by_employee_id`     INT NULL DEFAULT NULL,
  `created_at`                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  `voided_at`                  TIMESTAMP NULL DEFAULT NULL,
  `voided_by_employee_id`      INT NULL DEFAULT NULL,
  `correction_of_salary_history_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `superseded_by_salary_history_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `correction_reason`          VARCHAR(500) NULL DEFAULT NULL,

  `open_marker`                BIGINT UNSIGNED GENERATED ALWAYS AS
                                 (CASE WHEN `effective_to` IS NULL AND `voided_at` IS NULL
                                       THEN `period_id` ELSE NULL END) STORED,

  PRIMARY KEY (`salary_history_id`),
  UNIQUE KEY `uq_salary_one_open` (`open_marker`),
  KEY `idx_salary_hist_employee` (`employee_id`, `effective_from`),
  KEY `idx_salary_hist_period` (`period_id`, `effective_from`),
  CONSTRAINT `fk_salary_hist_employee` FOREIGN KEY (`employee_id`)
    REFERENCES `new_employee` (`employee_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_salary_hist_period` FOREIGN KEY (`period_id`)
    REFERENCES `employee_employment_period` (`period_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_salary_hist_interval` CHECK (`effective_to` IS NULL OR `effective_to` > `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================ 8. the verified baseline ====
-- The one-time cleanup. ~630 employee rows are what Digisme last wrote plus
-- whatever has been typed since; they are not automatically historical truth,
-- so HR reviews them before any of it becomes authoritative history.
CREATE TABLE IF NOT EXISTS `hr_baseline_batch` (
  `batch_id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `state`                     ENUM('DRAFT','VALIDATED','IMPORTED','ABANDONED') NOT NULL DEFAULT 'DRAFT',
  `go_live_date`              DATE NULL DEFAULT NULL,
  `exported_by_employee_id`   INT NULL DEFAULT NULL,
  `exported_at`               TIMESTAMP NULL DEFAULT NULL,
  -- Maker-checker on salary. The preparer and the reviewer must differ; the
  -- service enforces that, because a second signature from the same person
  -- is not a second pair of eyes.
  `salary_prepared_by_employee_id` INT NULL DEFAULT NULL,
  `salary_prepared_at`        TIMESTAMP NULL DEFAULT NULL,
  `salary_reviewed_by_employee_id` INT NULL DEFAULT NULL,
  `salary_reviewed_at`        TIMESTAMP NULL DEFAULT NULL,
  `salary_review_note`        VARCHAR(500) NULL DEFAULT NULL,
  `home_outlet_confirmed_by_employee_id` INT NULL DEFAULT NULL,
  `home_outlet_confirmed_at`  TIMESTAMP NULL DEFAULT NULL,
  `imported_by_employee_id`   INT NULL DEFAULT NULL,
  `imported_at`               TIMESTAMP NULL DEFAULT NULL,
  `total_rows`                INT NOT NULL DEFAULT 0,
  `valid_rows`                INT NOT NULL DEFAULT 0,
  `error_rows`                INT NOT NULL DEFAULT 0,
  `stale_rows`                INT NOT NULL DEFAULT 0,
  `note`                      VARCHAR(500) NULL DEFAULT NULL,
  `created_at`                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`),
  KEY `idx_baseline_batch_state` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per employee in the batch.
--
-- `source_fingerprint` is taken at EXPORT over the governed fields only, and
-- recomputed at validate time. If it differs, somebody legitimately changed
-- one of those fields while the sheet was being prepared, and the row is
-- STALE rather than silently overwriting the newer value. The scope is
-- narrow on purpose: an unrelated mobile-number edit must not invalidate
-- somebody's salary baseline.
CREATE TABLE IF NOT EXISTS `hr_baseline_row` (
  `baseline_row_id`      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id`             BIGINT UNSIGNED NOT NULL,
  `employee_id`          INT NOT NULL,

  `outlet_id`            INT NULL DEFAULT NULL,
  `department_id`        INT NULL DEFAULT NULL,
  `designation_id`       INT NULL DEFAULT NULL,
  `shift_id`             INT NULL DEFAULT NULL,
  `salary`               DECIMAL(12,2) NULL DEFAULT NULL,
  `payment_type`         VARCHAR(45) NULL DEFAULT NULL,
  `employment_status`    TINYINT NULL DEFAULT NULL,

  `source_fingerprint`   CHAR(64) NOT NULL COMMENT 'governed fields at export',
  `validated_fingerprint` CHAR(64) NULL DEFAULT NULL COMMENT 'governed fields when last validated',
  `validation_state`     ENUM('PENDING','VALID','WARNING','ERROR','STALE') NOT NULL DEFAULT 'PENDING',
  `error_codes`          VARCHAR(1000) NULL DEFAULT NULL COMMENT 'safe codes, never values',
  `salary_differs`       TINYINT(1) NOT NULL DEFAULT 0,
  `reconciled_by_employee_id` INT NULL DEFAULT NULL,
  `reconciled_at`        TIMESTAMP NULL DEFAULT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`baseline_row_id`),
  UNIQUE KEY `uq_baseline_row` (`batch_id`, `employee_id`),
  KEY `idx_baseline_row_state` (`batch_id`, `validation_state`),
  CONSTRAINT `fk_baseline_row_batch` FOREIGN KEY (`batch_id`)
    REFERENCES `hr_baseline_batch` (`batch_id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================================ 9. bulk assignment ======
-- A bulk transfer is many single transfers, run through the same service.
-- The batch exists so that closing the browser after 12 of 40 loses nothing:
-- the 12 are committed and recorded, and the rest can be retried without
-- redoing them.
CREATE TABLE IF NOT EXISTS `employee_assignment_batch` (
  `batch_id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `effective_from`   DATE NOT NULL,
  `change_type`      VARCHAR(45) NOT NULL,
  `reason`           VARCHAR(500) NOT NULL,
  `outlet_id`        INT NULL DEFAULT NULL,
  `department_id`    INT NULL DEFAULT NULL,
  `designation_id`   INT NULL DEFAULT NULL,
  `status`           ENUM('PENDING','RUNNING','COMPLETED','PARTIAL') NOT NULL DEFAULT 'PENDING',
  `total_count`      INT NOT NULL DEFAULT 0,
  `success_count`    INT NOT NULL DEFAULT 0,
  `failed_count`     INT NOT NULL DEFAULT 0,
  `created_by_employee_id` INT NULL DEFAULT NULL,
  `created_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`),
  KEY `idx_assignment_batch_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `employee_assignment_batch_item` (
  `batch_item_id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id`               BIGINT UNSIGNED NOT NULL,
  `employee_id`            INT NOT NULL,
  `previous_assignment_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `new_assignment_id`      BIGINT UNSIGNED NULL DEFAULT NULL,
  `status`                 ENUM('PENDING','SUCCESS','FAILED','SKIPPED') NOT NULL DEFAULT 'PENDING',
  `error_code`             VARCHAR(64) NULL DEFAULT NULL COMMENT 'safe code, never a value',
  `processed_at`           TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`batch_item_id`),
  -- One result per employee per batch: a retry updates its row rather than
  -- creating a second assignment for somebody who already succeeded.
  UNIQUE KEY `uq_batch_employee` (`batch_id`, `employee_id`),
  KEY `idx_batch_item_status` (`batch_id`, `status`),
  CONSTRAINT `fk_batch_item_batch` FOREIGN KEY (`batch_id`)
    REFERENCES `employee_assignment_batch` (`batch_id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================================== 10. shadow-mode violations ===
-- BASELINE_VALIDATED detects legacy callers still writing governed fields
-- without breaking them yet. What is recorded is WHO and WHERE - never the
-- value. A shadow log containing salaries would be a salary leak with an
-- innocent name.
CREATE TABLE IF NOT EXISTS `hr_governed_shadow_violation` (
  `violation_id`       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `occurred_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `route`              VARCHAR(255) NULL DEFAULT NULL,
  `method`             VARCHAR(10) NULL DEFAULT NULL,
  `actor_employee_id`  INT NULL DEFAULT NULL,
  `actor_user_id`      INT NULL DEFAULT NULL,
  `employee_id`        INT NULL DEFAULT NULL,
  `field_names`        VARCHAR(255) NOT NULL COMMENT 'names only - never values',
  `correlation_id`     VARCHAR(64) NULL DEFAULT NULL,
  `resolved_at`        TIMESTAMP NULL DEFAULT NULL,
  `resolved_by_employee_id` INT NULL DEFAULT NULL,
  `resolution_note`    VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`violation_id`),
  KEY `idx_shadow_unresolved` (`resolved_at`, `occurred_at`),
  KEY `idx_shadow_route` (`route`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================================== 11. the permissions ===
-- Declared only. Granted to nobody by this migration - the same discipline
-- C2 used for `view_aadhaar_full` and `override_duplicate_bank_account`.
--
-- `hr_activate_history` is deliberately its own key rather than a reuse of
-- `employee_edit`: activation is one-way and turns 630 legacy rows into
-- authoritative history. An ordinary HR editor must not be able to do it by
-- holding the permission they need for everyday work.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k.`permission_key` FROM (
      SELECT 'manage_employee_assignment'   AS `permission_key`
      UNION ALL SELECT 'correct_employee_assignment'
      UNION ALL SELECT 'manage_employee_shift'
      UNION ALL SELECT 'manage_employee_salary'
      UNION ALL SELECT 'correct_employee_salary'
      UNION ALL SELECT 'manage_department_tree'
      UNION ALL SELECT 'manage_designation_tree'
      UNION ALL SELECT 'manage_designation_mapping'
      UNION ALL SELECT 'hr_baseline_review'
      UNION ALL SELECT 'hr_activate_history'
  ) k
  WHERE NOT EXISTS (
    SELECT 1 FROM `all_permissions` p WHERE p.`permission_key` = k.`permission_key`
  );
