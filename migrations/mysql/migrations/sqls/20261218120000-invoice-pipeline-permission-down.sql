-- Removes the key and any grant of it made since.
DELETE FROM `permissions` WHERE `permission_key` = 'view_invoice_pipeline';
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_invoice_pipeline';
