-- Reverses 20261216140000-po-followup-up.sql. DESTROYS EVERY FOLLOW-UP REMARK.
DROP TABLE IF EXISTS po_followups;
DELETE FROM `permissions` WHERE `permission_key` = 'add_po_followup';
DELETE FROM `all_permissions` WHERE `permission_key` = 'add_po_followup';
