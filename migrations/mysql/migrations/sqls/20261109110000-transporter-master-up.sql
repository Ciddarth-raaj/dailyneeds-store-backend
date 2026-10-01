-- =====================================================================
-- Transporter Master: one reusable list of transporters.
--
-- The LR Follow-up (for both Advance Requests and Credit Purchases) and the
-- Credit Purchase entry point at a transporter by `transporter_id`; neither
-- stores a transporter name as text. There is one list - not one for
-- advances and another for credit purchases.
--
-- A transporter is never deleted. There is no DELETE in the application,
-- and the foreign keys from credit_purchases and lr_followup (added by the
-- next migration) refuse to let a referenced row go. A transporter that is
-- no longer used is made inactive: old records still show it, and it stops
-- being offered for new entries.
--
-- Duplicate protection: `transporter_name_key` is the name trimmed, inner
-- whitespace collapsed and lower-cased (utils/transporter.js nameKey), and
-- it is unique, so "VRL  Logistics" cannot be added beside "vrl logistics".
-- =====================================================================

CREATE TABLE transporter_master (
    transporter_id        INT PRIMARY KEY AUTO_INCREMENT,
    transporter_name      VARCHAR(150) NOT NULL,
    transporter_name_key  VARCHAR(150) NOT NULL COMMENT 'trimmed, collapsed, lower-cased name; unique',
    contact_no            VARCHAR(20)  NOT NULL COMMENT 'normalised: 10-digit mobile, or landline with STD code',
    alternate_contact_no  VARCHAR(20)  NULL,
    contact_person        VARCHAR(100) NULL,
    is_active             TINYINT(1)   NOT NULL DEFAULT 1,
    remarks               VARCHAR(500) NULL,
    created_by            INT(11)      NULL,
    created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by            INT(11)      NULL,
    updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_transporter_name_key (transporter_name_key),
    KEY idx_transporter_active (is_active, transporter_name)
) ENGINE = InnoDB;

-- Every create and every edit, field by field, append-only. The row above
-- carries who last touched it; this carries what they changed.
CREATE TABLE transporter_master_audit (
    transporter_audit_id  BIGINT PRIMARY KEY AUTO_INCREMENT,
    transporter_id        INT NOT NULL,
    action                ENUM('CREATE','UPDATE') NOT NULL,
    field                 VARCHAR(64) NOT NULL,
    old_value             VARCHAR(500) NULL,
    new_value             VARCHAR(500) NULL,
    changed_by            INT(11) NULL,
    changed_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_transporter_audit (transporter_id, changed_at),
    CONSTRAINT fk_transporter_audit FOREIGN KEY (transporter_id)
        REFERENCES transporter_master(transporter_id)
) ENGINE = InnoDB;

-- Granted to nobody; administrators hold every key without a grant.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_transporter_master' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_transporter_master');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'create_transporter_master' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'create_transporter_master');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_transporter_master' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_transporter_master');
