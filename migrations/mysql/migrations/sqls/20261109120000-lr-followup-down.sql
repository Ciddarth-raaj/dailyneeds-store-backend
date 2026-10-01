-- Reverses 20261109120000-lr-followup-up.sql.
--
-- DESTROYS FOLLOW-UP HISTORY AND EVERY CREDIT PURCHASE RAISED SINCE. Only
-- for rolling back a deploy before the module is in use. Advance requests
-- are not touched.
DROP TABLE IF EXISTS lr_followup_activity;
DROP TABLE IF EXISTS lr_followup;
DROP TABLE IF EXISTS credit_purchases;

DELETE FROM `permissions` WHERE `permission_key` IN (
  'view_lr_followup', 'update_lr_followup', 'mark_lr_goods_received',
  'manage_lr_legacy_verification', 'view_credit_purchase', 'create_credit_purchase'
);
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_lr_followup', 'update_lr_followup', 'mark_lr_goods_received',
  'manage_lr_legacy_verification', 'view_credit_purchase', 'create_credit_purchase'
);
