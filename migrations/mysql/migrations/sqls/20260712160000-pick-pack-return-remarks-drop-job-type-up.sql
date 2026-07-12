ALTER TABLE pick_pack_return_remarks
  DROP INDEX idx_pick_pack_return_remarks_job_type_active,
  DROP COLUMN job_type,
  ADD INDEX idx_pick_pack_return_remarks_is_active (is_active);
