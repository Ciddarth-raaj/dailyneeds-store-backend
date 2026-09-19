-- Reverses the marker column. Any account that was flagged becomes an
-- ordinary employee-linked login again, and employee-wide revocation will
-- reach it once more.
ALTER TABLE `user`
  DROP COLUMN `is_service_account`;
