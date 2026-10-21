-- Removes the account-sheet all-stores key. `view_account_sheet` stays: it
-- may have been granted to Accounts Executive before this migration.
DELETE FROM `permissions` WHERE `permission_key` = 'account_sheet_all_stores';
DELETE FROM `all_permissions` WHERE `permission_key` = 'account_sheet_all_stores';
