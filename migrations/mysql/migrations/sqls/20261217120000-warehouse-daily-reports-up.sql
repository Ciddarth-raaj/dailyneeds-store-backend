-- Warehouse Daily Reports: the five RetailPilot exports the team uploads
-- every morning - Picking, Packing, Verification, Loading, Unloading - kept
-- row for row so they can be analysed across days.
--
-- One upload per report per day: uploading the same report for the same day
-- again replaces it (its rows go with it, ON DELETE CASCADE).
--
-- Picking, Packing and Verification share one shape (an article per store,
-- with Short Qty - the write-off); Loading and Unloading share another (an
-- article in a box on a truck). Article ids are RetailPilot article ids, the
-- same as product_table.product_id, but the files carry their own names,
-- departments and categories and are kept as uploaded - no foreign key, so a
-- new article never stops an upload.
CREATE TABLE wh_report_uploads (
    upload_id    INT PRIMARY KEY AUTO_INCREMENT,
    report_type  ENUM('PICKING','PACKING','VERIFICATION','LOADING','UNLOADING') NOT NULL,
    report_date  DATE NOT NULL,
    file_name    VARCHAR(255) NULL,
    row_count    INT NOT NULL DEFAULT 0,
    uploaded_by  INT(11) NULL,
    uploaded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wh_report_uploads (report_type, report_date),
    KEY idx_wh_report_uploads_date (report_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE wh_report_job_rows (
    row_id          BIGINT PRIMARY KEY AUTO_INCREMENT,
    upload_id       INT NOT NULL,
    report_type     ENUM('PICKING','PACKING','VERIFICATION') NOT NULL,
    report_date     DATE NOT NULL,
    job_type        VARCHAR(20) NULL,
    from_store      VARCHAR(100) NULL,
    to_store        VARCHAR(100) NULL,
    article_id      INT NOT NULL,
    article_name    VARCHAR(255) NULL,
    department      VARCHAR(150) NULL,
    category        VARCHAR(150) NULL,
    recommended_qty DECIMAL(15,3) NULL,
    planned_qty     DECIMAL(15,3) NULL,
    advised_qty     DECIMAL(15,3) NULL,
    actual_qty      DECIMAL(15,3) NULL,
    short_qty       DECIMAL(15,3) NOT NULL DEFAULT 0 COMMENT 'the write-off',
    returned_qty    DECIMAL(15,3) NULL,
    jobs            INT NULL,
    open_jobs       INT NULL,
    mrp             DECIMAL(15,2) NULL COMMENT 'from the file MRP Split, else the latest RetailPilot GRN',
    mrp_source      ENUM('FILE','GRN') NULL,
    CONSTRAINT fk_wh_report_job_rows_upload FOREIGN KEY (upload_id) REFERENCES wh_report_uploads (upload_id) ON DELETE CASCADE,
    KEY idx_wh_report_job_rows_date (report_date),
    KEY idx_wh_report_job_rows_type_date (report_type, report_date),
    KEY idx_wh_report_job_rows_article (article_id, report_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE wh_report_box_rows (
    row_id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    upload_id        INT NOT NULL,
    report_type      ENUM('LOADING','UNLOADING') NOT NULL,
    report_date      DATE NOT NULL,
    job_type         VARCHAR(20) NULL,
    from_store       VARCHAR(100) NULL,
    planned_to_store VARCHAR(100) NULL,
    unloaded_store   VARCHAR(100) NULL,
    box_id           VARCHAR(64) NOT NULL,
    box_kind         VARCHAR(30) NULL,
    truck_no         VARCHAR(30) NULL,
    article_id       INT NOT NULL,
    article_name     VARCHAR(255) NULL,
    department       VARCHAR(150) NULL,
    category         VARCHAR(150) NULL,
    mrp              DECIMAL(15,2) NULL,
    box_qty          DECIMAL(15,3) NOT NULL DEFAULT 0,
    box_status       VARCHAR(30) NULL,
    finished_at      DATETIME NULL COMMENT 'IST, as in the file',
    CONSTRAINT fk_wh_report_box_rows_upload FOREIGN KEY (upload_id) REFERENCES wh_report_uploads (upload_id) ON DELETE CASCADE,
    KEY idx_wh_report_box_rows_type_date (report_type, report_date),
    KEY idx_wh_report_box_rows_box (box_id, article_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_wh_daily_reports' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_wh_daily_reports');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'upload_wh_daily_reports' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'upload_wh_daily_reports');
