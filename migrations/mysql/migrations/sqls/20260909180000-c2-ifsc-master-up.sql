-- Stage 0C / C2 — the local IFSC master, so an IFSC is looked up once.
--
-- ADDITIVE ONLY. One new table. No employee row, no verification, and no
-- existing column is touched, and the whole file is guarded so it can be
-- re-run without error.
--
-- ================================================== WHY A TABLE AT ALL ====
--
-- An IFSC maps to a bank and a branch, and that mapping is a fact about the
-- Indian banking system rather than about an employee: it is the same answer
-- for every employee who banks at that branch, and it changes only when a
-- branch is merged or renamed. Asking a paid provider the same question once
-- per employee would be spending money to be told something we were already
-- told.
--
-- So the answer is kept, keyed by the IFSC, and re-asked only when it is old
-- enough to be worth re-asking. `last_checked_at` is what makes that
-- decision; the freshness window itself lives in config/sandbox_kyc.js, not
-- in the schema, because it is a policy and not a fact.
--
-- ============================================= WHAT IT DELIBERATELY LACKS ==
--
-- Sandbox returns a good deal more - city, district, state, address, MICR,
-- and which of NEFT/RTGS/IMPS/UPI a branch supports. None of it is stored.
-- Bank name and branch name are the only two the Bank Details form fills in,
-- and a column nobody reads is a column that goes stale unnoticed.
--
-- This table holds NO employee data. It is a cache of public reference data,
-- and it is not sensitive: it says nothing about who banks where.

CREATE TABLE IF NOT EXISTS `ifsc_master` (
  `ifsc` VARCHAR(11) NOT NULL,
  `bank_name` VARCHAR(255) NOT NULL,
  `branch_name` VARCHAR(255) NOT NULL,
  -- When the provider last confirmed the two names above. The cache-freshness
  -- comparison is made against this and nothing else.
  `last_checked_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- The IFSC is the identity. It is stored normalised - upper-case, no
  -- spaces - so `sbin0010507` and `SBIN 0010507` are the same row, and the
  -- primary key is what makes two concurrent lookups of one IFSC converge on
  -- one row instead of racing to create two.
  PRIMARY KEY (`ifsc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
