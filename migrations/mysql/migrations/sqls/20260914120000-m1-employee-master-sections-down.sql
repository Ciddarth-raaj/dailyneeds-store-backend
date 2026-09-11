-- Reverses the two M1 section keys, by name. Nothing else is touched.
-- With the keys gone the section checks in /employee/updatedata fail CLOSED
-- for everyone but an administrator; restoring the previous behaviour means
-- deploying the previous code too.
DELETE FROM `permissions` WHERE `permission_key` IN ('edit_payment_details', 'edit_statutory_details');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('edit_payment_details', 'edit_statutory_details');
