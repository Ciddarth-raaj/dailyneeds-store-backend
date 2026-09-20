-- Reverses DN-EMPLOYEE-LOCATION-SCOPE.
--
-- Dropping the column loses which employees were marked roaming; there is
-- nowhere else that fact is recorded, so a re-run of the up migration starts
-- everybody at FIXED again. Stated rather than worked around: the alternative
-- would be an archive table nothing else reads.
ALTER TABLE `new_employee` DROP COLUMN `works_all_locations`;
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_employee_location_scope';
