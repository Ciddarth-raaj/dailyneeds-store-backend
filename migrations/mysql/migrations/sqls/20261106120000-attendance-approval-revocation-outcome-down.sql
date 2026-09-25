-- Remove the revocation outcome columns. The revocation rows themselves, and
-- every request, step, override and day row, are untouched.
ALTER TABLE `attendance_approval_revocation`
  DROP COLUMN `withdrawn_override_ids`,
  DROP COLUMN `reopened_stage_no`,
  DROP COLUMN `new_request_status`;
