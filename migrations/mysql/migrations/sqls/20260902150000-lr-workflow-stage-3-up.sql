-- =====================================================================
-- LR Workflow stage 3: match the advance request to how the team
-- actually raises one
--
-- Three corrections from the floor:
--
--  1. The supplier is picked from the distributor master (the same list
--     /master/distributors shows), not from people_list. A supplier here
--     is a distributor the business buys from, and that master is where
--     they are maintained.
--
--  2. The reference is an invoice or proforma invoice number, not a
--     purchase order number - and an advance is often asked for before
--     any number exists, so it is optional.
--
--  3. The reason is optional. The request note the team sends today
--     carries supplier, invoice no, amount, date, requester and whether
--     there is an attachment; there is no reason line.
--
-- The tables are dropped and recreated rather than altered: they were
-- created hours ago, no advance request has been raised against them,
-- and recreating avoids depending on the auto-generated foreign key
-- constraint names that an ALTER would have to name explicitly.
-- =====================================================================

DROP TABLE IF EXISTS advance_request_activity;
DROP TABLE IF EXISTS advance_request_documents;
DROP TABLE IF EXISTS advance_requests;

CREATE TABLE advance_requests (
    advance_request_id       BIGINT PRIMARY KEY AUTO_INCREMENT,

    -- A1 - raised by the requester
    invoice_number           VARCHAR(100) NULL,
    distributor_code         INT NOT NULL,
    amount                   DECIMAL(12,2) NOT NULL,
    reason                   VARCHAR(500) NULL,
    outlet_id                INT NULL,
    status                   ENUM('submitted','verified','on_hold',
                                  'approved','rejected','paid')
                             NOT NULL DEFAULT 'submitted',

    -- A1.1 - old balance check by accounts
    pending_bills            DECIMAL(12,2) NULL,
    previous_advance_balance DECIMAL(12,2) NULL,
    balance_remarks          VARCHAR(500) NULL,
    balance_checked_by       INT(11) NULL,
    balance_checked_at       TIMESTAMP NULL DEFAULT NULL,

    -- A2 - approval decision
    approval_status          TINYINT(1) NULL,
    approval_note            VARCHAR(500) NULL,
    approved_by              INT(11) NULL,
    approved_at              TIMESTAMP NULL DEFAULT NULL,

    -- A3 - payment record
    paid_amount              DECIMAL(12,2) NULL,
    utr                      VARCHAR(100) NULL,
    bank_id                  INT NULL,
    payment_date             DATE NULL,
    paid_by                  INT(11) NULL,
    paid_at                  TIMESTAMP NULL DEFAULT NULL,

    created_by               INT(11) NOT NULL,
    created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,

    -- The supplier is a distributor, keyed on the master's own primary
    -- key. The bank stays in people_list, where person_type 6 lives.
    CONSTRAINT fk_advreq_distributor FOREIGN KEY (distributor_code)
        REFERENCES product_distributor_master(mdm_dist_code),
    CONSTRAINT fk_advreq_bank FOREIGN KEY (bank_id)
        REFERENCES people_list(person_id)
) ENGINE = InnoDB;

CREATE INDEX idx_advreq_status      ON advance_requests(status, created_at);
CREATE INDEX idx_advreq_distributor ON advance_requests(distributor_code);
CREATE INDEX idx_advreq_invoice     ON advance_requests(invoice_number);
CREATE INDEX idx_advreq_outlet      ON advance_requests(outlet_id);

-- A1 supporting docs and the A3 proof of payment. One shape for both: the
-- file is already uploaded through POST /asset, only its URL is stored.
CREATE TABLE advance_request_documents (
    document_id        BIGINT PRIMARY KEY AUTO_INCREMENT,
    advance_request_id BIGINT NOT NULL,
    stage              ENUM('a1','a3') NOT NULL,
    file_url           VARCHAR(500) NOT NULL,
    uploaded_by        INT(11) NULL,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (advance_request_id)
        REFERENCES advance_requests(advance_request_id) ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE INDEX idx_advreq_doc ON advance_request_documents(advance_request_id, stage);

-- Who moved the request, when, and from what to what. An advance is money,
-- so every stage transition is recorded rather than only the latest state.
CREATE TABLE advance_request_activity (
    activity_id        BIGINT PRIMARY KEY AUTO_INCREMENT,
    advance_request_id BIGINT NOT NULL,
    employee_id        INT(11) NULL,
    field              VARCHAR(64) NOT NULL,
    old_value          VARCHAR(255) NULL,
    new_value          VARCHAR(255) NULL,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (advance_request_id)
        REFERENCES advance_requests(advance_request_id) ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE INDEX idx_advreq_act ON advance_request_activity(advance_request_id, created_at);
