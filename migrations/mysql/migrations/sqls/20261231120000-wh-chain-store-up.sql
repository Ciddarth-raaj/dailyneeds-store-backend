-- The stage chain, worked out once per day and stored, so Warehouse Health
-- only reads it (working it out on every page view from 10 Oct took the
-- site down).
--
-- wh_chain_days       one row per day: TODO (to work out / redo after a
--                     re-pull), DONE with the day's result (JSON: the stage
--                     chain and box chain as the page shows them), or FAILED.
-- wh_chain_open       what was still waiting at the end of the day, per gap
--                     (to_pack / to_load / to_verify): the next day starts
--                     from it instead of re-reading every earlier day.
-- wh_chain_open_boxes box trips loaded and not unloaded by the end of the day.
CREATE TABLE wh_chain_days (
    chain_date   DATE NOT NULL PRIMARY KEY,
    status       ENUM('TODO','DONE','FAILED') NOT NULL DEFAULT 'TODO',
    gen          INT NOT NULL DEFAULT 0 COMMENT 'goes up each time the day is marked to redo: a result worked out meanwhile is not final',
    result       MEDIUMTEXT NULL,
    no_links     TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'the day has lines pulled before job states / links were kept',
    error        VARCHAR(500) NULL,
    computed_at  DATETIME NULL,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_wh_chain_days_status (status, chain_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE wh_chain_open (
    open_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    chain_date   DATE NOT NULL,
    gap          VARCHAR(12) NOT NULL,
    since        DATE NOT NULL,
    stage_id     VARCHAR(64) NULL,
    article_id   INT NOT NULL,
    article_name VARCHAR(255) NULL,
    from_store   VARCHAR(100) NULL,
    to_store     VARCHAR(100) NULL,
    links        VARCHAR(1000) NULL,
    qty          DECIMAL(15,3) NOT NULL,
    nlc          DECIMAL(15,2) NULL,
    KEY idx_wh_chain_open_day (chain_date, gap)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE wh_chain_open_boxes (
    open_box_id  BIGINT PRIMARY KEY AUTO_INCREMENT,
    chain_date   DATE NOT NULL,
    loaded_on    DATE NOT NULL,
    box_id       VARCHAR(64) NOT NULL,
    job_id       VARCHAR(64) NULL,
    stage_id     VARCHAR(64) NULL,
    from_store   VARCHAR(100) NULL,
    to_store     VARCHAR(100) NULL,
    job_type     VARCHAR(20) NULL,
    truck_no     VARCHAR(30) NULL,
    articles     INT NOT NULL DEFAULT 0,
    qty          DECIMAL(15,3) NOT NULL DEFAULT 0,
    value        DECIMAL(15,2) NOT NULL DEFAULT 0,
    loaded_at    VARCHAR(19) NULL,
    KEY idx_wh_chain_open_boxes_day (chain_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- A box trip's articles are looked up by its job.
ALTER TABLE wh_report_box_rows ADD INDEX idx_wh_report_box_rows_job (job_id);
