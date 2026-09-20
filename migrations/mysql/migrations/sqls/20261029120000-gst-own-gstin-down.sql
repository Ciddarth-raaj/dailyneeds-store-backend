ALTER TABLE sandbox_gst_taxpayer_session
  DROP FOREIGN KEY fk_sandbox_gst_session_own_gstin;

ALTER TABLE sandbox_gst_taxpayer_session
  DROP COLUMN own_gstin_id;

DROP TABLE IF EXISTS gst_own_gstin;
