-- Employee Telegram group JOIN ATTEMPTS - Phase 3B.
--
-- ADDITIVE ONLY. One new table. No existing table, column, row, permission or
-- grant is touched, and no new permission key is created: the employee
-- endpoints reuse `view_employees` and the `employee_create OR employee_edit`
-- pair that Telegram onboarding already uses.
--
-- WHY THIS IS DURABLE AND NOT AN IN-MEMORY MAP. A join is ASYNCHRONOUS and
-- crosses a process boundary we do not control: we issue a link, a human
-- taps it minutes later, and Telegram delivers `chat_join_request` whenever
-- it delivers it. An in-memory attempt dies with the next deploy or pm2
-- reload - and the employee, who did nothing wrong, would have their join
-- silently refused with no record of why. A row survives the restart.
--
-- ============================================ WHAT IS STORED, AND WHY ======
--
-- `invite_link_hash` IS A SHA-256 OF THE INVITE URL, NEVER THE URL ITSELF.
-- The URL is a working credential: anybody holding it can send a join
-- request to a real company group. It is returned ONCE, in the response to
-- the deliberate action that created it, and after that only its hash
-- exists here - so a database read, a backup, or a log line cannot hand
-- somebody a way in. Telegram echoes the same URL back on the join request,
-- so hashing is enough to correlate and nothing weaker is being substituted.
--
-- NO TELEGRAM USER ID IS STORED HERE. The identity check at approval time
-- reads `employee_telegram_identity`, which already owns that column and
-- already scopes it to the active identity. A second copy here would be a
-- second thing to keep in step, and the one that drifted would be the one
-- deciding whether to let somebody into a group.
--
-- ================================================= ONE LIVE ATTEMPT ========
--
-- `live_marker` is the generated column that makes "one outstanding attempt
-- per employee per group" a DATABASE rule rather than a hopeful pre-check.
-- It carries the employee/group pair only while the attempt is PENDING and
-- NULL otherwise; MySQL allows many NULLs in a UNIQUE index, so concluded
-- attempts pile up as history without colliding, and two simultaneous
-- Generate clicks cannot both leave a live row. This is the same pattern
-- `employee_telegram_identity.active_employee_marker` uses for the same
-- reason.
--
-- STATUSES. PENDING is outstanding. JOIN_REQUEST_RECEIVED records that
-- Telegram delivered the request. APPROVED records that we approved it -
-- which is IRREVERSIBLE in the sense that matters, because a person is now
-- in a real group - and JOINED that membership was afterwards verified
-- against Telegram. EXPIRED, SUPERSEDED and FAILED are the ways an attempt
-- ends without a join. Nothing here ever removes anybody from a group; that
-- is Phase 3C and this table has no column for it.

CREATE TABLE IF NOT EXISTS `employee_telegram_group_join_attempt` (
  `employee_telegram_group_join_attempt_id` INT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `telegram_group_id` INT NOT NULL,
  `invite_link_hash` CHAR(64) NOT NULL
    COMMENT 'sha256 of the invite URL. The URL itself is returned once and never stored',
  `status` ENUM('PENDING','JOIN_REQUEST_RECEIVED','APPROVED','JOINED','EXPIRED','SUPERSEDED','FAILED')
    NOT NULL DEFAULT 'PENDING',
  `expires_at` DATETIME NOT NULL,
  `created_by` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at` DATETIME NULL DEFAULT NULL,
  `concluded_at` DATETIME NULL DEFAULT NULL
    COMMENT 'when it stopped being outstanding - superseded, expired or failed',
  -- VIRTUAL, NOT STORED, AND THE DIFFERENCE IS THE FOREIGN KEY BELOW. MySQL
  -- refuses `ON DELETE CASCADE` on a column that a STORED generated column is
  -- computed from - `ER_CANNOT_ADD_FOREIGN`, which is exactly how this
  -- migration failed in production. The cascade is the part worth keeping:
  -- the registry really does hard-delete groups, and a deleted group must
  -- take its join attempts with it rather than leave rows pointing at
  -- nothing. A VIRTUAL column is computed on read, is not a stored base-column
  -- dependency, and carries the same UNIQUE index - so the invariant is
  -- unchanged and only the storage is.
  `live_marker` VARCHAR(32) AS
    (CASE WHEN `status` = 'PENDING'
          THEN CONCAT(`employee_id`, ':', `telegram_group_id`) ELSE NULL END) VIRTUAL,
  PRIMARY KEY (`employee_telegram_group_join_attempt_id`),
  UNIQUE KEY `uq_etgja_live` (`live_marker`),
  UNIQUE KEY `uq_etgja_invite_hash` (`invite_link_hash`),
  KEY `idx_etgja_employee` (`employee_id`),
  KEY `idx_etgja_group` (`telegram_group_id`),
  KEY `idx_etgja_status` (`status`),
  CONSTRAINT `fk_etgja_group` FOREIGN KEY (`telegram_group_id`)
    REFERENCES `telegram_group_registry` (`telegram_group_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
