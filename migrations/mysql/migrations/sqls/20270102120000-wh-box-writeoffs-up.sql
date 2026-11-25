-- Boxes written off at loading in RetailPilot (a loading job ending in state
-- LOADING_WRITEOFF - done outside the app's normal flow). Kept on their own
-- so the loading reports and box chain stay as they are: the stage chain
-- counts their goods as moved on (written off), not as stuck waiting to be
-- loaded, and Pick Pack Daily Report lists them as an exception.
CREATE TABLE wh_box_writeoffs (
    writeoff_id  BIGINT PRIMARY KEY AUTO_INCREMENT,
    report_date  DATE NOT NULL COMMENT 'the IST day the write-off was done',
    job_id       VARCHAR(64) NULL,
    box_id       VARCHAR(64) NOT NULL,
    stage_id     VARCHAR(64) NULL,
    job_type     VARCHAR(20) NULL,
    from_store   VARCHAR(100) NULL,
    to_store     VARCHAR(100) NULL,
    article_id   INT NOT NULL,
    article_name VARCHAR(255) NULL,
    qty          DECIMAL(15,3) NOT NULL DEFAULT 0,
    nlc          DECIMAL(15,4) NULL,
    picking_job  VARCHAR(64) NULL,
    packing_jobs VARCHAR(1000) NULL,
    finished_at  VARCHAR(19) NULL,
    KEY idx_wh_box_writeoffs_day (report_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
