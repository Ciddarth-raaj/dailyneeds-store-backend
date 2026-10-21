-- ACCOUNTS EXECUTIVE SEES EVERY STORE'S ACCOUNT SHEET.
--
--   account_sheet_all_stores   /accounts lists every outlet and lets the
--                              holder pick any of them, instead of locking
--                              the selector to their own store
--
-- Scoped to the account sheet on purpose. `all_stores` would do the same
-- here but also unlocks the store on every other screen.
--
-- Granted to Accounts Executive (designation 15), together with
-- `view_account_sheet` so the page appears in their menu. Administrators
-- need no grant. Anyone else gets it on the Designation rights screen.
--
-- Additive and idempotent. An existing row, active or not, is left alone.

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'account_sheet_all_stores' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'account_sheet_all_stores');

INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM (SELECT 'account_sheet_all_stores' AS `permission_key`
          UNION SELECT 'view_account_sheet') k
    JOIN `designation` d ON d.`designation_id` = 15
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );
