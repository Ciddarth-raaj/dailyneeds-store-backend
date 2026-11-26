-- Reverses 20270107120000-po-followup-stop-up.sql. DELETES every stop and
-- resume record (remarks are kept).
DELETE FROM po_followups WHERE kind <> 'REMARK';
ALTER TABLE po_followups
  DROP KEY idx_po_followups_kind,
  DROP COLUMN stop_reason,
  DROP COLUMN kind,
  MODIFY COLUMN channel ENUM('CALL','WHATSAPP','EMAIL','VISIT') NOT NULL,
  MODIFY COLUMN remark VARCHAR(1000) NOT NULL;
DELETE FROM `permissions` WHERE `permission_key` = 'stop_po_followup';
DELETE FROM `all_permissions` WHERE `permission_key` = 'stop_po_followup';
