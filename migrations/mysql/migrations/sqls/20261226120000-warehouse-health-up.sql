-- Warehouse Health (dashboard under Invoice Pipeline, and its 9 am Telegram
-- summary to the warehouse manager).
--
-- wh_report_job_rows.stage_id     the source document (STA / invoice / ...)
-- wh_report_job_rows.picking_job  on a Verification line: the picking job its
--                                 goods came from (RetailPilot line meta
--                                 picking_job), so a shortage the store finds
--                                 is traced back to the picker.
ALTER TABLE wh_report_job_rows
  ADD COLUMN stage_id VARCHAR(64) NULL AFTER job_id,
  ADD COLUMN picking_job VARCHAR(64) NULL AFTER stage_id,
  ADD INDEX idx_wh_report_job_rows_job (job_id),
  ADD INDEX idx_wh_report_job_rows_picking_job (picking_job);

-- One row per recipient per day, so a restart or a second run never sends twice.
CREATE TABLE wh_health_summary_sends (
    wh_health_summary_send_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    summary_date     DATE NOT NULL COMMENT 'the day the summary is about',
    employee_id      INT(11) NOT NULL,
    status           ENUM('SENT','FAILED','SKIPPED') NOT NULL,
    reason           VARCHAR(255) NULL,
    telegram_chat_id VARCHAR(64) NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wh_health_summary (summary_date, employee_id)
) ENGINE = InnoDB;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_warehouse_health' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_warehouse_health');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'receive_warehouse_health_summary' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'receive_warehouse_health_summary');
