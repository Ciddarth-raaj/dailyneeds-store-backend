-- ACCOUNTS EXECUTIVE GETS THE PAYMENT / RECEIPTS RECONCILIATION PAGE.
--
-- /reconciliation/payment-receipts lists the Account Sheet's payment and
-- receipt entries. It now honours `account_sheet_all_stores` (granted to
-- Accounts Executive in 20261210120000), so its store selector is unlocked
-- for them. This adds the page's own view key so it appears in their menu.
--
-- Additive and idempotent. An existing row, active or not, is left alone.

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_payment_receipts_reconciliation' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_payment_receipts_reconciliation');

INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'view_payment_receipts_reconciliation', d.`designation_id`, TRUE
    FROM `designation` d
   WHERE d.`designation_id` = 15
     AND NOT EXISTS (
       SELECT 1 FROM `permissions` p
        WHERE p.`permission_key` = 'view_payment_receipts_reconciliation'
          AND p.`designation_id` = d.`designation_id` );
