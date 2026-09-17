-- THE RECONCILIATION QUEUE. Phase 3C.
--
-- ADDITIVE ONLY. One new table, no permission, nothing existing touched.
--
-- ===================================== WHY A QUEUE AND NOT A DIRECT CALL ===
--
-- An HR change is a DATABASE transaction; a Telegram change is a NETWORK
-- call to somebody else's service. Doing the second inside the first means a
-- Telegram outage rolls back a resignation - which is absurd, because the
-- person has still resigned. So the business change and a row in this table
-- commit together, atomically, and the network work happens afterwards on
-- its own schedule. A failure here delays cleanup; it never loses an HR fact.
--
-- ================================= THE JOB CARRIES SCOPE, NOT A PAYLOAD ====
--
-- A job says "recompute employee 42", never "employee 42 moved to outlet 7".
-- Truth is re-read when the job RUNS, so a job that waited an hour behind a
-- rate limit reconciles what is true now rather than replaying what was true
-- when it was queued. This is what makes it idempotent and what makes an
-- interrupted run repairable by simply running it again.
--
-- ======================================== ONE LIVE JOB PER SCOPE ===========
--
-- `live_job_marker` carries the scope only while the job is PENDING or
-- RUNNING and is NULL once concluded; MySQL allows many NULLs in a UNIQUE
-- index, so history piles up while the live set stays exact. Fifty edits to
-- one employee in a minute collapse into one pending job.
--
-- VIRTUAL, NOT STORED. A STORED generated column forbids ON DELETE CASCADE
-- on any column it is computed from - that is the rule that took the Phase
-- 3B deploy down with ER_CANNOT_ADD_FOREIGN. Nothing here carries such a key
-- today; VIRTUAL means adding one later cannot resurrect that failure, and
-- the UNIQUE index behaves identically.
--
-- ============================================ rerun_requested =============
--
-- THE FLAG THAT STOPS WORK BEING LOST. A change arriving while its scope is
-- already RUNNING must not create a second live job - the unique marker
-- forbids it - and must not be dropped either. The enqueue upsert sets this
-- flag, the claim clears it, and completion reads it in the SAME statement
-- that concludes the job, so a change that lands between the worker's last
-- read and its completion sends the job back to PENDING instead of vanishing.
--
-- `last_error_detail` IS BOUNDED AND SANITISED: an error code and Telegram's
-- own short description. No payload, no token, no invite URL, no mobile.

CREATE TABLE IF NOT EXISTS `telegram_membership_job` (
  `telegram_membership_job_id` BIGINT NOT NULL AUTO_INCREMENT,
  `scope_type` ENUM('EMPLOYEE','GROUP') NOT NULL,
  `scope_id` INT NOT NULL,
  `reason` ENUM('EMPLOYEE_CREATED','EMPLOYEE_EDITED','JOINING_DATE_CORRECTED',
                'RESIGNED','REJOINED','TELEGRAM_CONNECTED','TELEGRAM_RECONNECTED',
                'TELEGRAM_DISCONNECTED','MAPPING_ADDED','MAPPING_REMOVED',
                'MANUAL_GRANTED','MANUAL_REVOKED','SWEEP','ADMIN_REQUEUE') NOT NULL,
  `status` ENUM('PENDING','RUNNING','SUCCEEDED','DEAD') NOT NULL DEFAULT 'PENDING',
  `rerun_requested` TINYINT(1) NOT NULL DEFAULT 0,
  `failure_count` INT NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME NOT NULL,
  `last_error_code` VARCHAR(48) NULL DEFAULT NULL,
  `last_error_detail` VARCHAR(200) NULL DEFAULT NULL
    COMMENT 'bounded, sanitised. Never a payload, token, invite URL or mobile',
  `claimed_at` DATETIME NULL DEFAULT NULL,
  `finished_at` DATETIME NULL DEFAULT NULL,
  `enqueued_by` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `live_job_marker` VARCHAR(40) AS
    (CASE WHEN `status` IN ('PENDING','RUNNING')
          THEN CONCAT(`scope_type`, ':', `scope_id`) ELSE NULL END) VIRTUAL,
  PRIMARY KEY (`telegram_membership_job_id`),
  UNIQUE KEY `uq_tmj_live` (`live_job_marker`),
  KEY `idx_tmj_due` (`status`,`next_attempt_at`),
  KEY `idx_tmj_claimed` (`status`,`claimed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
