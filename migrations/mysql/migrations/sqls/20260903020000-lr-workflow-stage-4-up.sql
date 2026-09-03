-- =====================================================================
-- LR Workflow stage 4: the flow the team actually runs
--
-- The workflow was built from a four-stage mockup that did not describe
-- the real process. Three corrections:
--
--  1. When accounts find a previous balance the request goes BACK to the
--     purchase team, who decide whether to less-and-pay (deduct the old
--     balance from this payment) or defer it and clarify with the
--     supplier later. Nothing modelled that round trip.
--
--  2. That decision is now recorded. previous_advance_balance used to be
--     written once and only ever displayed - nothing said what was
--     decided about it.
--
--  3. The hold belongs to the admin, not to accounts. Accounts record
--     the balance and pass the request on; the admin holds, re-clarifies,
--     decides the deduction and approves.
--
-- Statuses now name who the request is waiting on:
--   submitted                 -> waiting on accounts
--   pending_purchase_decision -> back with purchase, balance found
--   pending_approval          -> waiting on the admin
--   on_hold                   -> the admin is holding it
--   approved                  -> waiting on accounts to pay
--   rejected / paid           -> closed
--
-- Dropped and recreated as stage 3 was: the flow and every status name
-- have changed, so rows raised under the old model carry no meaning here.
-- =====================================================================

DROP TABLE IF EXISTS advance_request_activity;
DROP TABLE IF EXISTS advance_request_documents;
DROP TABLE IF EXISTS advance_requests;

CREATE TABLE advance_requests (
    advance_request_id       BIGINT PRIMARY KEY AUTO_INCREMENT,

    -- A1 - raised by the purchase team
    invoice_number           VARCHAR(100) NULL,
    distributor_code         INT NOT NULL,
    amount                   DECIMAL(12,2) NOT NULL,
    reason                   VARCHAR(500) NULL,
    outlet_id                INT NULL,
    status                   ENUM('submitted','pending_purchase_decision',
                                  'pending_approval','on_hold',
                                  'approved','rejected','paid')
                             NOT NULL DEFAULT 'submitted',

    -- A1.1 - accounts record what the supplier already holds. 0 means
    -- nothing outstanding, which sends the request straight to the admin.
    previous_advance_balance DECIMAL(12,2) NULL,
    balance_remarks          VARCHAR(500) NULL,
    balance_checked_by       INT(11) NULL,
    balance_checked_at       TIMESTAMP NULL DEFAULT NULL,

    -- A1.2 - what to do about that balance. Set by purchase when the
    -- request comes back to them, or by the admin when releasing a hold.
    -- The figure itself is worked out in Tally; only the decision is kept.
    balance_action           ENUM('less_and_pay','defer') NULL,
    balance_action_note      VARCHAR(500) NULL,
    balance_action_by        INT(11) NULL,
    balance_action_at        TIMESTAMP NULL DEFAULT NULL,

    -- A2 - the admin's decision. The outcome lives in `status`; the
    -- activity log carries the history, including any holds along the way.
    approval_note            VARCHAR(500) NULL,
    approved_by              INT(11) NULL,
    approved_at              TIMESTAMP NULL DEFAULT NULL,

    -- A3 - payment made through Tally, recorded here with its advice
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

    CONSTRAINT fk_advreq_distributor FOREIGN KEY (distributor_code)
        REFERENCES product_distributor_master(mdm_dist_code),
    CONSTRAINT fk_advreq_bank FOREIGN KEY (bank_id)
        REFERENCES people_list(person_id)
) ENGINE = InnoDB;

CREATE INDEX idx_advreq_status      ON advance_requests(status, created_at);
CREATE INDEX idx_advreq_distributor ON advance_requests(distributor_code);
CREATE INDEX idx_advreq_invoice     ON advance_requests(invoice_number);
CREATE INDEX idx_advreq_outlet      ON advance_requests(outlet_id);

-- A1 supporting docs and the A3 payment advice. One shape for both: the
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
