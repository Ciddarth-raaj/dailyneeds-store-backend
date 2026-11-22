-- Reverses 20270101120000-wh-chain-views-up.sql.
DELETE FROM `permissions` WHERE `permission_key` = 'receive_store_health_summary';
DELETE FROM `all_permissions` WHERE `permission_key` = 'receive_store_health_summary';
ALTER TABLE wh_health_summary_sends DROP COLUMN site;
DROP TABLE IF EXISTS wh_chain_results;
ALTER TABLE wh_chain_open_boxes DROP COLUMN view_key;
ALTER TABLE wh_chain_open DROP COLUMN view_key;
