INSERT INTO `all_permissions` (`permission_key`) VALUES ('sync_purchase_acknowledgement');

CREATE TABLE IF NOT EXISTS purchase_acknowledgement_imported (
  mmm_no INT NOT NULL,
  mmm_sno INT NOT NULL DEFAULT 0 COMMENT 'Line serial; 0 when source mmm_sno was NULL',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mmm_no, mmm_sno)
) COMMENT 'Tracks medishopdb_med_mrc_memo rows already synced into purchase_acknowledgement';
