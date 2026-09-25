-- Remove the bulk-action correlation log.
--
-- Dropped because this migration created it and nothing depends on it. The
-- requests' own history - decided steps and revocation rows - is untouched:
-- every bulk decision is still recorded there exactly as a single one is.
DROP TABLE IF EXISTS `attendance_approval_bulk_action_item`;
