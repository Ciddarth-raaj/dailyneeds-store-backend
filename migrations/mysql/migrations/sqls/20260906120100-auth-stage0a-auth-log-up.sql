-- Stage 0A: authentication audit log and the query-string login metric.
--
-- user_auth_log never holds a password, a hash, a token, a JWT or a key.
-- `detail` is a short free-text reason such as 'unknown_user' or
-- 'legacy_query_string'; the code that writes it is the only place that
-- decides what goes in, and it is reviewed for exactly that.
CREATE TABLE `user_auth_log` (
  `log_id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NULL,
  `username_attempted` VARCHAR(100) NULL,
  `event` VARCHAR(48) NOT NULL,
  `ip` VARCHAR(45) NULL,
  `user_agent` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `actor_user_id` INT NULL COMMENT 'the admin acting, for unlock/reset events',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`log_id`),
  INDEX `idx_auth_log_user` (`user_id`, `created_at`),
  INDEX `idx_auth_log_event` (`event`, `created_at`),
  INDEX `idx_auth_log_username` (`username_attempted`, `created_at`)
) ENGINE=InnoDB;

-- Daily counters with no per-request detail: how many logins arrived with
-- credentials in the query string, how many in the body. The removal of the
-- query-string fallback is gated on this reading zero.
CREATE TABLE `auth_metric` (
  `metric` VARCHAR(64) NOT NULL,
  `day` DATE NOT NULL,
  `count` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`metric`, `day`)
) ENGINE=InnoDB;
