ALTER TABLE pick_pack_return_remarks
  DROP INDEX idx_pick_pack_return_remarks_is_active,
  ADD COLUMN job_type ENUM('GRN', 'STA') NOT NULL DEFAULT 'GRN' AFTER label,
  ADD INDEX idx_pick_pack_return_remarks_job_type_active (job_type, is_active);
