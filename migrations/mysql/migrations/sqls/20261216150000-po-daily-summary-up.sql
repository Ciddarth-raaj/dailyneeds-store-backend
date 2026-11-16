-- PO daily follow-up summary on Telegram (7 pm, Mon-Sat): one row per
-- recipient per day, so a restart or a second run never sends twice.
CREATE TABLE po_daily_summary_sends (
    po_daily_summary_send_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    summary_date             DATE NOT NULL,
    employee_id              INT(11) NOT NULL,
    status                   ENUM('SENT','FAILED','SKIPPED') NOT NULL,
    reason                   VARCHAR(255) NULL,
    telegram_chat_id         VARCHAR(64) NULL,
    created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_po_daily_summary (summary_date, employee_id)
) ENGINE = InnoDB;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'receive_po_daily_summary' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'receive_po_daily_summary');
