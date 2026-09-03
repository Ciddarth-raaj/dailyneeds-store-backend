-- Restores the stage 2 shape: supplier from people_list, a mandatory
-- purchase order number, and a mandatory reason.

DROP TABLE IF EXISTS advance_request_activity;
DROP TABLE IF EXISTS advance_request_documents;
DROP TABLE IF EXISTS advance_requests;

CREATE TABLE advance_requests (
    advance_request_id       BIGINT PRIMARY KEY AUTO_INCREMENT,
    purchase_order_number    VARCHAR(100) NOT NULL,
    supplier_id              INT NOT NULL,
    amount                   DECIMAL(12,2) NOT NULL,
    reason                   VARCHAR(500) NOT NULL,
    outlet_id                INT NULL,
    status                   ENUM('submitted','verified','on_hold',
                                  'approved','rejected','paid')
                             NOT NULL DEFAULT 'submitted',
    pending_bills            DECIMAL(12,2) NULL,
    previous_advance_balance DECIMAL(12,2) NULL,
    balance_remarks          VARCHAR(500) NULL,
    balance_checked_by       INT(11) NULL,
    balance_checked_at       TIMESTAMP NULL DEFAULT NULL,
    approval_status          TINYINT(1) NULL,
    approval_note            VARCHAR(500) NULL,
    approved_by              INT(11) NULL,
    approved_at              TIMESTAMP NULL DEFAULT NULL,
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
    FOREIGN KEY (supplier_id) REFERENCES people_list(person_id),
    FOREIGN KEY (bank_id)     REFERENCES people_list(person_id)
) ENGINE = InnoDB;

CREATE INDEX idx_advreq_status   ON advance_requests(status, created_at);
CREATE INDEX idx_advreq_supplier ON advance_requests(supplier_id);
CREATE INDEX idx_advreq_po       ON advance_requests(purchase_order_number);
CREATE INDEX idx_advreq_outlet   ON advance_requests(outlet_id);

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
