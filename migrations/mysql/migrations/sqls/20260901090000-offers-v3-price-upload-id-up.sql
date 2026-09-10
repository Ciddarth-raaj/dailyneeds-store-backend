-- The price sheet is a complete list of every live batch, but this table is
-- only ever inserted into or updated - a batch that stops appearing keeps its
-- last-known price forever. Stamping each row with the upload that wrote it
-- makes "in the current sheet" answerable, so checks can ignore the rest.
ALTER TABLE `offers_v3_batch_data`
  ADD COLUMN `price_upload_id` VARCHAR(32) NULL DEFAULT NULL AFTER `price_uploaded_at`,
  ADD KEY `idx_price_upload_id` (`price_upload_id`);
