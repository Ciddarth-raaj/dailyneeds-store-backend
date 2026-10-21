-- ACCOUNTS EXECUTIVE GETS THE RECONCILIATION DIFFERENCE PAGE.
--
-- /reconciliation/difference already lets any user pick any store; its
-- outlet names now come from the outlet directory and its employee names
-- from the accounts response. This adds the page's view key so it appears
-- in Accounts Executive's menu.
--
-- Additive and idempotent. An existing row, active or not, is left alone.

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_reconciliation_difference' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_reconciliation_difference');

INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT 'view_reconciliation_difference', d.`designation_id`, TRUE
    FROM `designation` d
   WHERE d.`designation_id` = 15
     AND NOT EXISTS (
       SELECT 1 FROM `permissions` p
        WHERE p.`permission_key` = 'view_reconciliation_difference'
          AND p.`designation_id` = d.`designation_id` );
