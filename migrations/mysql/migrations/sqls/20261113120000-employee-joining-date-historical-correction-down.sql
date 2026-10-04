-- Removes the key and any grant of it made since. Joining-date corrections
-- already recorded keep their lifecycle events; nothing else is touched.
DELETE FROM `permissions` WHERE `permission_key` = 'employee_joining_date_historical_correction';
DELETE FROM `all_permissions` WHERE `permission_key` = 'employee_joining_date_historical_correction';
