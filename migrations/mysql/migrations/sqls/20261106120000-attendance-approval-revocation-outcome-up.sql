-- =====================================================================
-- Admin "Revoke" - the audit row records the OUTCOME as well as the origin.
--
-- `attendance_approval_revocation` already keeps the decision being revoked
-- and the request as it stood. With Shift revoke there are two outcomes:
--
--   Attendance / OT, and an APPROVED Shift   -> the request is CANCELLED
--   a REJECTED Shift                         -> the request is REOPENED:
--                                               back to PENDING at the stage
--                                               that rejected it
--
-- so the row now states which, at which stage, and - for an approved Shift -
-- which one-day override rows stopped applying with it.
--
-- ADDITIVE ONLY: three NULLable columns. Rows written before this migration
-- keep NULL. No row is written or changed.
-- =====================================================================
ALTER TABLE `attendance_approval_revocation`
  ADD COLUMN `new_request_status` VARCHAR(16) NULL
    COMMENT 'the request status the revocation left: CANCELLED, or PENDING for a reopened Shift rejection'
    AFTER `original_request_decided_at`,
  ADD COLUMN `reopened_stage_no` INT NULL
    COMMENT 'the stage a reopened request resumes at, NULL when cancelled'
    AFTER `new_request_status`,
  ADD COLUMN `withdrawn_override_ids` JSON NULL
    COMMENT 'attendance_date_shift_override ids that stopped applying (approved Shift only)'
    AFTER `reopened_stage_no`;
