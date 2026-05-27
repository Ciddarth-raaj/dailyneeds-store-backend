ALTER TABLE gst_tally_purchase
  ADD COLUMN source ENUM('tally', 'system') NOT NULL DEFAULT 'tally' AFTER master_id;

-- Pushed from purchase via purchase_tally_response (POST /purchase-tally snapshot).
UPDATE gst_tally_purchase g
INNER JOIN purchase_tally_response tr ON tr.MasterID = g.master_id
SET g.source = 'system';

-- Match migration rows copied from purchase without a Tally MasterID yet.
UPDATE gst_tally_purchase
SET source = 'system'
WHERE master_id LIKE 'purchase-%';

ALTER TABLE gst_tally_purchase
  ADD KEY idx_gst_tally_purchase_source (source);
