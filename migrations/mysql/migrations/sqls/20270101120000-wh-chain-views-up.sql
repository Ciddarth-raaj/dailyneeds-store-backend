-- Warehouse Health per site. The stage chain and box chain are worked out
-- separately for every site, both ways:
--   from:<store>  what the site SENT (picked / packed / loaded there),
--   to:<store>    what was sent TO the site (unloaded / verified there).
-- Each view starts each day from its own end of the day before, so the
-- still-waiting rows carry the view they belong to, and each view's result
-- is stored on its own row (the page reads one site only).
-- Store managers get their own store's 9 am summary on Telegram
-- (receive_store_health_summary, by the employee's store).
ALTER TABLE wh_chain_open ADD COLUMN view_key VARCHAR(110) NOT NULL DEFAULT 'all' AFTER chain_date;
ALTER TABLE wh_chain_open_boxes ADD COLUMN view_key VARCHAR(110) NOT NULL DEFAULT 'all' AFTER chain_date;

CREATE TABLE wh_chain_results (
    chain_date DATE NOT NULL,
    view_key   VARCHAR(110) NOT NULL,
    result     MEDIUMTEXT NOT NULL,
    PRIMARY KEY (chain_date, view_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

ALTER TABLE wh_health_summary_sends ADD COLUMN site VARCHAR(100) NULL AFTER employee_id;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'receive_store_health_summary' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'receive_store_health_summary');
