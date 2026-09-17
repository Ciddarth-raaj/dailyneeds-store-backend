INSERT INTO `all_permissions` (`permission_key`) VALUES ('verify_grn');

-- GRN headers/lines live in the GoFrugal database and are read-only here, so
-- the verification is a Daily Needs row keyed by the GRN reference number
-- rather than a column on the synced source table.
--
-- The UNIQUE key on mmh_mrc_refno is what makes a double approval safe: the
-- insert is a plain INSERT, so a second click loses the race with a duplicate
-- key error the repository reads as "already verified" instead of overwriting
-- who verified and when. verified_at defaults to the server's
-- CURRENT_TIMESTAMP and is never supplied by a caller; it is read back with
-- UNIX_TIMESTAMP so the API can name the instant rather than a wall clock in
-- an unstated zone.
--
-- verified_by is NOT NULL: this row exists to say WHO signed the GRN off, and
-- one that names nobody is not an audit record. The endpoint refuses a
-- request with no authenticated employee before it ever gets here.
CREATE TABLE IF NOT EXISTS grn_verifications (
  grn_verification_id INT AUTO_INCREMENT PRIMARY KEY,
  mmh_mrc_refno VARCHAR(50) NOT NULL,
  verified_by INT NOT NULL,
  verified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_grn_verifications_refno (mmh_mrc_refno)
);
