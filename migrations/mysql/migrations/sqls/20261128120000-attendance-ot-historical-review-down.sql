-- Reverses 20261128120000. The OT requests a review created are ordinary
-- requests and are NOT removed; only the review's own audit tables go.
DELETE FROM `permissions` WHERE `permission_key` = 'attendance_ot_historical_review';
DELETE FROM `all_permissions` WHERE `permission_key` = 'attendance_ot_historical_review';
DROP TABLE IF EXISTS `attendance_ot_historical_review_raised`;
DROP TABLE IF EXISTS `attendance_ot_historical_review_item`;
DROP TABLE IF EXISTS `attendance_ot_historical_review_batch`;
