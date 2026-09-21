-- Remove the HR shift change block: its table and its one permission key.
--
-- THE TABLE IS DROPPED BECAUSE THIS MIGRATION CREATED IT and nothing else
-- reads it. Every block and its history goes with it - which is the known and
-- accepted cost of reversing this feature, and the reason a down migration is
-- a deliberate act rather than a routine one. Nothing else depends on these
-- rows: a block gates a request that was never created, so dropping them
-- restores exactly the behaviour that existed before the feature.
--
-- NO ATTENDANCE, PUNCH, SHIFT, EMPLOYEE, REQUEST OR PAYROLL TABLE IS TOUCHED,
-- because the `up` created none and altered none. In particular no shift
-- change request is altered, reopened or re-decided by this rollback.
DROP TABLE IF EXISTS `attendance_shift_change_block`;

DELETE FROM `permissions` WHERE `permission_key` = 'manage_shift_change_eligibility';
DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_shift_change_eligibility';
