-- Stage 0C / C1a — the employee-lifecycle schema. ADDITIVE ONLY.
--
-- Nothing here writes to an existing table's rows, backfills anything, or
-- changes application behaviour. It creates the tables the local lifecycle
-- will use, adds four nullable columns to `resignation`, and defines the
-- canonical current-period view. `new_employee` is not touched at all.
--
-- The lifecycle itself - join, resign, void, rejoin - is C1c. Until then
-- these tables stay empty and nothing reads them.

-- ---------------------------------------------------------------- periods
-- One row per employment period. A rejoin adds a period; it never edits or
-- replaces an earlier one, so the history survives every cycle of
-- join -> resign -> rejoin -> resign.
--
-- `period_state` is explicit rather than derived from `ended_on IS NULL`,
-- because a real historical case needs both: 93 employees in the restored
-- copy are inactive with NO resignation date. Their period is closed with an
-- unknown end. Deriving open-ness from the date would make every one of them
-- read as currently employed.
--
-- `open_marker` exists only to carry the "at most one open period per
-- employee" rule into the database: it holds the employee_id while the period
-- is open and NULL once closed, and MySQL's unique indexes do not collide on
-- NULLs. Three different writers (HR screens, the backfill, and later the
-- sync) touch this table, so the invariant is enforced here rather than
-- trusted to each of them.
CREATE TABLE IF NOT EXISTS `employee_employment_period` (
  `period_id`       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`     INT NOT NULL,
  `period_no`       SMALLINT UNSIGNED NOT NULL,
  `period_state`    ENUM('open','closed') NOT NULL,
  `joined_on`       DATE NULL DEFAULT NULL,
  `ended_on`        DATE NULL DEFAULT NULL,
  `end_reason_type` ENUM('resignation','termination','contract_end','absconded','deceased','unknown')
                    NULL DEFAULT NULL,
  `end_note`        VARCHAR(255) NULL DEFAULT NULL,
  `source`          ENUM('backfill','local') NOT NULL,
  `needs_review`    TINYINT(1) NOT NULL DEFAULT 0,
  `created_by`      INT NULL DEFAULT NULL,
  `updated_by`      INT NULL DEFAULT NULL,
  `created_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `open_marker`     INT GENERATED ALWAYS AS
                      (CASE WHEN `period_state` = 'open' THEN `employee_id` ELSE NULL END) STORED,
  PRIMARY KEY (`period_id`),
  UNIQUE KEY `uq_period_seq` (`employee_id`, `period_no`),
  UNIQUE KEY `uq_one_open_period` (`open_marker`),
  KEY `idx_period_employee_state` (`employee_id`, `period_state`),
  KEY `idx_period_joined` (`joined_on`),
  KEY `idx_period_ended` (`ended_on`),
  KEY `idx_period_review` (`needs_review`),
  CONSTRAINT `fk_period_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- An open period cannot already have ended.
  CONSTRAINT `chk_period_open_has_no_end`
    CHECK (`period_state` <> 'open' OR `ended_on` IS NULL),
  -- Where both dates are known they must be in order. Either being unknown
  -- is allowed and common: 424 of 629 employees have no joining date.
  CONSTRAINT `chk_period_dates_ordered`
    CHECK (`ended_on` IS NULL OR `joined_on` IS NULL OR `ended_on` >= `joined_on`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------- events
-- Append-only. Nothing in the application may UPDATE or DELETE a row here;
-- a correction is a new event, which is what lets a resignation be voided
-- without destroying the evidence that it was recorded.
--
-- `period_id` is RESTRICT on purpose: a period that has audit history cannot
-- be deleted out from under it. The C1b backfill deliberately writes no
-- events - it records no lifecycle decision, only what the old columns
-- already said - so backfilled periods stay deletable for rollback.
CREATE TABLE IF NOT EXISTS `employee_lifecycle_event` (
  `event_id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`       INT NOT NULL,
  `period_id`         BIGINT UNSIGNED NULL DEFAULT NULL,
  `event_type`        ENUM('period_opened','period_closed','resignation_voided','period_corrected')
                      NOT NULL,
  `actor_employee_id` INT NULL DEFAULT NULL,
  `detail_json`       JSON NULL DEFAULT NULL,
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`event_id`),
  KEY `idx_event_employee` (`employee_id`, `created_at`),
  KEY `idx_event_period` (`period_id`),
  KEY `idx_event_type` (`event_type`, `created_at`),
  CONSTRAINT `fk_event_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_event_period`
    FOREIGN KEY (`period_id`) REFERENCES `employee_employment_period` (`period_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------ resignation
-- Four nullable columns. Nothing existing is removed or renamed, and no row
-- is written: `employee_name` remains the only populated link until C1c.
-- These give a resignation an employee and a period to belong to, and give a
-- mistaken one a way to be voided rather than deleted.
ALTER TABLE `resignation`
  ADD COLUMN `employee_id` INT NULL DEFAULT NULL AFTER `resignation_id`,
  ADD COLUMN `period_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `employee_id`,
  ADD COLUMN `voided_at` TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN `voided_by` INT NULL DEFAULT NULL,
  ADD KEY `idx_resignation_employee` (`employee_id`),
  ADD KEY `idx_resignation_period` (`period_id`),
  ADD CONSTRAINT `fk_resignation_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `fk_resignation_period`
    FOREIGN KEY (`period_id`) REFERENCES `employee_employment_period` (`period_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ------------------------------------------------------------------- view
-- The one place that answers "which period is this employee in now?".
--
-- The highest `period_no` is the current period: numbers only increase, and
-- at most one may be open, so the newest row is either the open period or -
-- for someone who has left - the most recent closed one. `period_state`
-- tells the two apart; callers must read it rather than assume employment.
CREATE OR REPLACE VIEW `v_employee_current_period` AS
SELECT
  p.`employee_id`,
  p.`period_id`,
  p.`period_no`,
  p.`period_state`,
  p.`joined_on`,
  p.`ended_on`,
  p.`end_reason_type`,
  p.`needs_review`
FROM `employee_employment_period` p
JOIN (
  SELECT `employee_id`, MAX(`period_no`) AS `period_no`
  FROM `employee_employment_period`
  GROUP BY `employee_id`
) latest
  ON latest.`employee_id` = p.`employee_id`
 AND latest.`period_no` = p.`period_no`;
