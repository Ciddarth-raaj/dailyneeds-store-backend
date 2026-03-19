ALTER TABLE purchase_acknowledgement
  ADD COLUMN mmm_refno INT NULL DEFAULT NULL COMMENT 'medishopdb_med_mrc_memo.mmm_refno' AFTER distributor_id,
  ADD COLUMN mmm_date DATETIME NULL DEFAULT NULL COMMENT 'medishopdb_med_mrc_memo.mmm_date' AFTER mmm_refno;