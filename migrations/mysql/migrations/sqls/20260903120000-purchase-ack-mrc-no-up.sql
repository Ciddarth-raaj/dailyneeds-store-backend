-- medishopdb_med_mrc_memo.mmm_mrc_no, the MRC number the memo was raised
-- against. Kept as text: the source column's type is not guaranteed
-- numeric, and this is reference data we only ever display.
ALTER TABLE purchase_acknowledgement
  ADD COLUMN mmm_mrc_no VARCHAR(50) NULL DEFAULT NULL COMMENT 'medishopdb_med_mrc_memo.mmm_mrc_no' AFTER mmm_date;
