-- Reverses 20261231120000-wh-chain-store-up.sql.
ALTER TABLE wh_report_box_rows DROP INDEX idx_wh_report_box_rows_job;
DROP TABLE IF EXISTS wh_chain_open_boxes;
DROP TABLE IF EXISTS wh_chain_open;
DROP TABLE IF EXISTS wh_chain_days;
