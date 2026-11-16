-- PO Tracker follow-ups: what the team heard when it chased a supplier
-- about a RetailPilot purchase order. Append-only - the application has no
-- UPDATE or DELETE for it. POs live in RetailPilot (read-only); a PO is
-- referred to here by its RetailPilot slug.
CREATE TABLE po_followups (
    po_followup_id         BIGINT PRIMARY KEY AUTO_INCREMENT,
    po_slug                VARCHAR(100) NOT NULL COMMENT 'RetailPilot po_headers.slug',
    po_ref                 VARCHAR(100) NULL,
    supplier_id            VARCHAR(64) NULL COMMENT 'RetailPilot supplier id',
    supplier_name          VARCHAR(255) NULL,
    store_id               VARCHAR(64) NULL COMMENT 'RetailPilot store id',
    channel                ENUM('CALL','WHATSAPP','EMAIL','VISIT') NOT NULL,
    remark                 VARCHAR(1000) NOT NULL,
    promised_delivery_date DATE NULL,
    next_follow_up_date    DATE NULL,
    created_by             INT(11) NOT NULL,
    created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_po_followups_po (po_slug, po_followup_id),
    KEY idx_po_followups_supplier (supplier_id, po_followup_id)
) ENGINE = InnoDB;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'add_po_followup' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'add_po_followup');
