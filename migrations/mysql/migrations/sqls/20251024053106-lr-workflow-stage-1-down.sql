DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'create_advance_request', 'view_advance_request', 'view_old_balance_check'
);
