-- PO Tracker: stop / resume following a PO (stock came from another
-- vendor, vendor changed, not needed). Recorded in po_followups beside the
-- remarks, still append-only: the latest STOP or RESUME on a PO decides
-- whether it is being followed.
ALTER TABLE po_followups
  ADD COLUMN kind ENUM('REMARK','STOP','RESUME') NOT NULL DEFAULT 'REMARK' AFTER store_id,
  ADD COLUMN stop_reason ENUM('OTHER_VENDOR','VENDOR_CHANGED','NOT_NEEDED','OTHER') NULL AFTER kind,
  MODIFY COLUMN channel ENUM('CALL','WHATSAPP','EMAIL','VISIT') NULL,
  MODIFY COLUMN remark VARCHAR(1000) NOT NULL DEFAULT '',
  ADD KEY idx_po_followups_kind (po_slug, kind, po_followup_id);

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'stop_po_followup' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'stop_po_followup');
