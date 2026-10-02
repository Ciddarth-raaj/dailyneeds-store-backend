-- Reverses 20261110120000. Restoring one punch per request REFUSES (duplicate
-- key) while any break-pair request exists: those rows are an approval's
-- audit record and are not deleted to make a rollback pass.
ALTER TABLE `attendance_regularized_punch`
  ADD UNIQUE KEY `uq_arp_request` (`attendance_approval_request_id`);

ALTER TABLE `attendance_regularized_punch`
  DROP INDEX `uq_arp_request_time`;
