DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'approve_advance_request', 'pay_advance_request', 'edit_advance_request'
);

DROP TABLE IF EXISTS advance_request_activity;
DROP TABLE IF EXISTS advance_request_documents;
DROP TABLE IF EXISTS advance_requests;
