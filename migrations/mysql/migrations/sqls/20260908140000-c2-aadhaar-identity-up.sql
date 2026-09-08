-- Stage 0C / C2 — Aadhaar verification and identity. ADDITIVE ONLY.
--
-- Two new tables and one permission key. `new_employee` is not touched: the
-- Aadhaar number lives in its own table so that no existing query, present or
-- future, can carry it by accident. That is a stronger guarantee than
-- filtering it out of responses, and it holds even for a `SELECT *` written
-- next year by someone who has never heard of B3.
--
-- The number is NEVER stored in plaintext. What is stored is AES-256-GCM
-- ciphertext with a per-row IV and auth tag, a keyed HMAC fingerprint for
-- duplicate detection, and the last four digits for display.

-- ------------------------------------------------------------ verification
-- One row per verification attempt, kept whatever the outcome, because the
-- audit question later is "what did we check, when, with whose consent" and
-- a failed check is part of that answer.
--
-- `demographics_json` holds ONLY what the provider asserted about the person
-- - name, date of birth, gender, address. It must never hold the number;
-- the application enforces that and a test pins it.
CREATE TABLE IF NOT EXISTS `employee_aadhaar_verification` (
  `verification_id`      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `aadhaar_fingerprint`  CHAR(64) NOT NULL COMMENT 'HMAC-SHA256 hex, keyed; never the number',
  `aadhaar_last4`        CHAR(4) NOT NULL,
  -- Held only between verification and the create that consumes it, then
  -- cleared. This is what lets the number cross the wire once.
  `aadhaar_ciphertext`   VARBINARY(64) NULL,
  `aadhaar_iv`           VARBINARY(16) NULL,
  `aadhaar_auth_tag`     VARBINARY(16) NULL,
  `key_version`          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `status`               ENUM('verified','failed','consumed','expired') NOT NULL,
  `provider`             VARCHAR(45) NOT NULL,
  `provider_reference`   VARCHAR(128) NULL,
  `failure_reason`       VARCHAR(255) NULL,
  `verified_at`          TIMESTAMP NULL DEFAULT NULL,
  -- Consent is not a boolean anyone can assume: who took it, under which
  -- wording, from where, and when.
  `consent_given`        TINYINT(1) NOT NULL DEFAULT 0,
  `consent_version`      VARCHAR(45) NULL,
  `consent_actor_employee_id` INT NULL,
  `consent_ip`           VARCHAR(45) NULL,
  `consent_at`           TIMESTAMP NULL DEFAULT NULL,
  `demographics_json`    JSON NULL COMMENT 'verified name/dob/gender/address only - never the number',
  `employee_id`          INT NULL COMMENT 'set when a create consumes this verification',
  `consumed_at`          TIMESTAMP NULL DEFAULT NULL,
  `expires_at`           TIMESTAMP NOT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`verification_id`),
  KEY `idx_aadhaar_verification_fingerprint` (`aadhaar_fingerprint`),
  KEY `idx_aadhaar_verification_status` (`status`, `expires_at`),
  KEY `idx_aadhaar_verification_employee` (`employee_id`),
  CONSTRAINT `fk_aadhaar_verification_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- identity
-- At most one Aadhaar per employee, and at most one employee per Aadhaar.
--
-- The unique fingerprint is the duplicate-person control: a second attempt to
-- create somebody who already exists cannot succeed, and the application
-- turns that into "this is employee 412, who left in 2024 - use Rejoin"
-- rather than a constraint error.
CREATE TABLE IF NOT EXISTS `employee_aadhaar_identity` (
  `aadhaar_identity_id`  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`          INT NOT NULL,
  `aadhaar_fingerprint`  CHAR(64) NOT NULL,
  `aadhaar_last4`        CHAR(4) NOT NULL,
  `aadhaar_ciphertext`   VARBINARY(64) NOT NULL,
  `aadhaar_iv`           VARBINARY(16) NOT NULL,
  `aadhaar_auth_tag`     VARBINARY(16) NOT NULL,
  `key_version`          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `verification_id`      BIGINT UNSIGNED NULL,
  `verified_at`          TIMESTAMP NULL DEFAULT NULL,
  `created_by`           INT NULL DEFAULT NULL,
  `updated_by`           INT NULL DEFAULT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`aadhaar_identity_id`),
  UNIQUE KEY `uq_aadhaar_identity_employee` (`employee_id`),
  UNIQUE KEY `uq_aadhaar_identity_fingerprint` (`aadhaar_fingerprint`),
  KEY `idx_aadhaar_identity_last4` (`aadhaar_last4`),
  CONSTRAINT `fk_aadhaar_identity_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_aadhaar_identity_verification`
    FOREIGN KEY (`verification_id`) REFERENCES `employee_aadhaar_verification` (`verification_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------- permission
-- Reading a stored number back - which PF and ESI will need - is its own
-- decision, above `view_employee_sensitive`. Declared only; granted to
-- nobody, so no designation gains it when this runs.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_aadhaar_full' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_aadhaar_full');
