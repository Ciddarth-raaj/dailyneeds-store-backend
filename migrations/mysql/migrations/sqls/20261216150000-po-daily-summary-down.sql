-- Reverses 20261216150000-po-daily-summary-up.sql.
DROP TABLE IF EXISTS po_daily_summary_sends;
DELETE FROM `permissions` WHERE `permission_key` = 'receive_po_daily_summary';
DELETE FROM `all_permissions` WHERE `permission_key` = 'receive_po_daily_summary';
