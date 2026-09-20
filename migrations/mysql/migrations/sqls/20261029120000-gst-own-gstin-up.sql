-- THE GST REGISTRATION THIS SERVER FILES FOR.
--
-- Until now the GST portal username and GSTIN were two string constants in
-- services/gst_authentication.js. Changing the registration meant editing
-- source, and the company's GSTIN sat in git history for anyone with read
-- access to the repository.
--
-- STRUCTURE ONLY. No GSTIN, no portal username, no key and no token is
-- written by this migration - the row is created at runtime from the
-- environment by services/gst_own_gstin_bootstrap.js. A migration is
-- replayed on every environment and lives in git forever, which is exactly
-- where company identifiers must not be.
--
-- ONE REGISTRATION TODAY. `is_active`/`is_default` and a surrogate key are
-- here so a second GSTIN is a row rather than a redesign, but nothing in
-- this phase reads more than the single active registration.
CREATE TABLE IF NOT EXISTS gst_own_gstin (
  own_gstin_id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  gstin           CHAR(15)     NOT NULL COMMENT 'Uppercase 15-char GSTIN this server files for',
  legal_name      VARCHAR(255) NULL,
  portal_username VARCHAR(64)  NOT NULL COMMENT 'GST portal / Sandbox taxpayer username',
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  is_default      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (own_gstin_id),
  UNIQUE KEY uq_gst_own_gstin_gstin (gstin),
  KEY idx_gst_own_gstin_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- WHICH REGISTRATION THE STORED TAXPAYER JWT BELONGS TO.
--
-- The session row is a singleton and, before this column, said nothing about
-- whose session it was. That was safe only while the GSTIN was a constant.
-- Once the registration is configuration, a token minted for one GSTIN could
-- silently be presented for another after someone edits an environment
-- variable - the GST portal would reject it at best, and at worst it would
-- act against the wrong registration.
--
-- NULL means "bound to nothing known". The existing production row becomes
-- NULL here and is therefore NOT reusable: the service refuses it and asks
-- for OTP once. That is deliberate. Backfilling it to the configured GSTIN
-- would be asserting something this migration cannot verify - that the
-- stored token was minted for whatever GSTIN the environment happens to
-- name today - and one OTP is a smaller price than a wrong assertion.
ALTER TABLE sandbox_gst_taxpayer_session
  ADD COLUMN own_gstin_id INT UNSIGNED NULL
    COMMENT 'gst_own_gstin the stored taxpayer JWT was issued for; NULL = unbound, unusable'
    AFTER id,
  ADD KEY idx_sandbox_gst_session_own_gstin (own_gstin_id),
  ADD CONSTRAINT fk_sandbox_gst_session_own_gstin
    FOREIGN KEY (own_gstin_id) REFERENCES gst_own_gstin (own_gstin_id)
    ON DELETE SET NULL;
