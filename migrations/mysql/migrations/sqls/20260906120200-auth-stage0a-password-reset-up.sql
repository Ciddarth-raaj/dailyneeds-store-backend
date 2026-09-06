-- Stage 0A / Deployment B: setup and reset tokens.
--
-- Only the SHA-256 of a token is stored. The token itself exists once, in
-- the response to the admin who requested it, and is never written anywhere
-- by this system.
CREATE TABLE `user_password_reset` (
  `reset_id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `purpose` VARCHAR(16) NOT NULL COMMENT 'setup | reset',
  `expires_at` DATETIME NOT NULL,
  `used_at` DATETIME NULL,
  `requested_by` INT NULL COMMENT 'user_id of the admin, NULL for self-service',
  `requested_ip` VARCHAR(45) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`reset_id`),
  UNIQUE KEY `uq_reset_token_hash` (`token_hash`),
  INDEX `idx_reset_user` (`user_id`, `created_at`)
) ENGINE=InnoDB;
