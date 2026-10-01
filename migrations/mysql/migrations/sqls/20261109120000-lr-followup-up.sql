-- =====================================================================
-- LR Follow-up: track paid-for and credit-bought goods until they are
-- physically received.
--
-- A follow-up starts when
--   * an Advance Request reaches `paid` (the existing A3 step - its
--     workflow is unchanged; the follow-up is written in the same
--     transaction as the payment), or
--   * a Credit Purchase is created in dnds.
-- and it closes only when the goods are physically received (or, through
-- the audited legacy / admin decision, when the money was refunded,
-- adjusted or the order cancelled).
--
-- Three new tables, six permission keys, nothing else. Builds on
-- 20261109110000-transporter-master:
--
--   credit_purchases       the minimal Credit Purchase entry, raised in dnds.
--                          dnds had no internal record of a credit purchase
--                          before this migration - the `purchase` table is
--                          the store's MRC push and only ever holds goods
--                          already received - so this is its source of truth.
--   lr_followup            one row per source, enforced by unique keys.
--   lr_followup_activity   append-only history. The application has no
--                          UPDATE or DELETE statement for it, and the
--                          foreign key below refuses to let a follow-up be
--                          deleted from under its history.
--
-- No existing table is altered and no existing row is written. Paid
-- advances that predate this migration are brought in by the backfill on
-- the Legacy Follow-up Verification screen, into VERIFICATION_REQUIRED -
-- not here, so that every backfilled row is created by the same code the
-- tests exercise, and records who ran it.
-- =====================================================================

CREATE TABLE credit_purchases (
    credit_purchase_id     BIGINT PRIMARY KEY AUTO_INCREMENT,
    -- Same supplier master as advance_requests.distributor_code.
    distributor_code       INT NOT NULL,
    bill_reference         VARCHAR(100) NOT NULL COMMENT 'Credit purchase / supplier bill reference',
    amount                 DECIMAL(12,2) NOT NULL,
    bill_date              DATE NOT NULL COMMENT 'Invoice / bill date; the follow-up ages from here',
    outlet_id              INT NOT NULL COMMENT 'Receiving outlet / location',
    transporter_id         INT NOT NULL,
    -- Dispatch details known when the purchase is entered. Optional; the
    -- follow-up starts with a copy and is where they are kept up to date.
    lr_no                  VARCHAR(100) NULL,
    dispatch_date          DATE NULL,
    expected_delivery_date DATE NULL,
    remarks                VARCHAR(500) NULL,
    -- The client's key for one press of Save. A double submit or a retry
    -- after a dropped response finds the first row instead of making a
    -- second purchase.
    request_key            VARCHAR(64) NULL,
    created_by             INT(11) NOT NULL,
    created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_credpur_request_key (request_key),
    -- One supplier bill is one credit purchase.
    UNIQUE KEY uq_credpur_supplier_bill (distributor_code, bill_reference),
    KEY idx_credpur_outlet (outlet_id),
    KEY idx_credpur_date (bill_date),
    CONSTRAINT fk_credpur_distributor FOREIGN KEY (distributor_code)
        REFERENCES product_distributor_master(mdm_dist_code),
    CONSTRAINT fk_credpur_transporter FOREIGN KEY (transporter_id)
        REFERENCES transporter_master(transporter_id)
) ENGINE = InnoDB;

CREATE TABLE lr_followup (
    lr_followup_id          BIGINT PRIMARY KEY AUTO_INCREMENT,

    source_type             ENUM('ADVANCE_REQUEST','CREDIT_PURCHASE') NOT NULL,
    advance_request_id      BIGINT NULL,
    credit_purchase_id      BIGINT NULL,

    -- Copied from the source when the follow-up is created, so the
    -- dashboard filters and branch scope never join through the source.
    distributor_code        INT NOT NULL,
    outlet_id               INT NULL,
    amount                  DECIMAL(12,2) NOT NULL,
    source_date             DATETIME NOT NULL COMMENT 'advance paid_at, or the credit purchase bill date; ageing runs from here',
    invoice_number          VARCHAR(100) NULL COMMENT 'advance invoice / PI no., or the credit purchase bill reference',

    -- Tracking. None of it is mandatory and none of it closes anything.
    lr_no                   VARCHAR(100) NULL,
    transporter_id          INT NULL COMMENT 'transporter_master; never free text',
    dispatch_date           DATE NULL,
    expected_delivery_date  DATE NULL,

    status                  ENUM('DISPATCH_PENDING','IN_TRANSIT','GOODS_RECEIVED',
                                 'CLOSED','VERIFICATION_REQUIRED')
                            NOT NULL DEFAULT 'DISPATCH_PENDING',
    closure_reason          ENUM('GOODS_RECEIVED','REFUNDED','ADJUSTED','CANCELLED') NULL,
    goods_received_at       DATETIME NULL,
    goods_received_by       INT(11) NULL,

    -- 1 = brought in by the go-live backfill rather than by a live trigger.
    is_legacy               TINYINT(1) NOT NULL DEFAULT 0,

    -- Latest follow-up, kept on the row for the dashboard. The history
    -- table is the record; these are a copy of its newest entry.
    last_follow_up_at       DATETIME NULL,
    next_follow_up_date     DATE NULL,
    latest_remark           VARCHAR(1000) NULL,

    created_by              INT(11) NULL COMMENT 'NULL when created by the system trigger',
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP,
    closed_at               DATETIME NULL,
    closed_by               INT(11) NULL,

    -- ONE FOLLOW-UP PER SOURCE. NULLs do not collide in a unique key, so
    -- each source column can carry its own.
    UNIQUE KEY uq_lrf_advance_request (advance_request_id),
    UNIQUE KEY uq_lrf_credit_purchase (credit_purchase_id),

    -- Exactly one source, and the one the type names.
    CONSTRAINT chk_lrf_source CHECK (
        (source_type = 'ADVANCE_REQUEST'
            AND advance_request_id IS NOT NULL AND credit_purchase_id IS NULL)
     OR (source_type = 'CREDIT_PURCHASE'
            AND credit_purchase_id IS NOT NULL AND advance_request_id IS NULL)
    ),
    -- A closed follow-up always says when and why.
    CONSTRAINT chk_lrf_closed CHECK (
        (status = 'CLOSED' AND closed_at IS NOT NULL AND closure_reason IS NOT NULL)
     OR (status <> 'CLOSED')
    ),

    KEY idx_lrf_status_expected (status, expected_delivery_date),
    KEY idx_lrf_source_date (source_date),
    KEY idx_lrf_distributor (distributor_code),
    KEY idx_lrf_outlet (outlet_id),
    KEY idx_lrf_transporter (transporter_id),

    CONSTRAINT fk_lrf_advance_request FOREIGN KEY (advance_request_id)
        REFERENCES advance_requests(advance_request_id),
    CONSTRAINT fk_lrf_credit_purchase FOREIGN KEY (credit_purchase_id)
        REFERENCES credit_purchases(credit_purchase_id),
    CONSTRAINT fk_lrf_distributor FOREIGN KEY (distributor_code)
        REFERENCES product_distributor_master(mdm_dist_code),
    CONSTRAINT fk_lrf_transporter FOREIGN KEY (transporter_id)
        REFERENCES transporter_master(transporter_id)
) ENGINE = InnoDB;

CREATE TABLE lr_followup_activity (
    lr_followup_activity_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    lr_followup_id          BIGINT NOT NULL,
    activity_type           ENUM('CREATED','FOLLOW_UP','LR_UPDATE',
                                 'EXPECTED_DELIVERY_CHANGE','GOODS_RECEIVED',
                                 'CLOSED','BACKFILL','VERIFICATION_DECISION')
                            NOT NULL,
    remark                  VARCHAR(1000) NULL,
    old_status              VARCHAR(32) NULL,
    new_status              VARCHAR(32) NULL,
    next_follow_up_date     DATE NULL,
    -- Before/after values of the fields an action changed.
    details                 TEXT NULL,
    -- The client's key for one submission. A retried submission finds the
    -- row it already wrote rather than writing the same history twice.
    request_key             VARCHAR(64) NULL,
    created_by              INT(11) NULL COMMENT 'NULL when written by the system',
    created_at              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE KEY uq_lrfa_request_key (lr_followup_id, request_key),
    KEY idx_lrfa_followup (lr_followup_id, created_at),

    -- No ON DELETE: a follow-up cannot be deleted while it has history.
    CONSTRAINT fk_lrfa_followup FOREIGN KEY (lr_followup_id)
        REFERENCES lr_followup(lr_followup_id)
) ENGINE = InnoDB;

-- `all_permissions` has no unique key on permission_key, so each insert
-- guards itself and a re-run adds nothing. GRANTED TO NOBODY: who may see
-- and act on supplier follow-ups is an administrator's decision on the
-- designation permissions screen. Administrators (user_type 2) hold every
-- key without a grant, so the module is reachable from the moment it ships.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_lr_followup' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_lr_followup');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'update_lr_followup' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'update_lr_followup');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'mark_lr_goods_received' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'mark_lr_goods_received');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_lr_legacy_verification' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_lr_legacy_verification');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_credit_purchase' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_credit_purchase');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'create_credit_purchase' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'create_credit_purchase');

-- REPORT ONLY: how many paid advances the backfill will bring in.
SELECT COUNT(*) AS `PAID_ADVANCES_AWAITING_BACKFILL_run_it_on_the_legacy_screen`
  FROM advance_requests WHERE status = 'paid';
