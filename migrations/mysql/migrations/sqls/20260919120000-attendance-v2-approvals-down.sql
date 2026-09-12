-- Reverses 20260919120000 exactly. `attendance_regularized_punch` and
-- `attendance_approval_step` cascade from the request table, but they are
-- dropped explicitly and first so the order is stated rather than relied upon.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('raise_attendance_regularization',
                            'raise_attendance_regularization_for_others',
                            'approve_attendance_regularization',
                            'view_attendance_approvals',
                            'manage_attendance_approval_roles');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('raise_attendance_regularization',
                            'raise_attendance_regularization_for_others',
                            'approve_attendance_regularization',
                            'view_attendance_approvals',
                            'manage_attendance_approval_roles');

DROP TABLE IF EXISTS `attendance_regularized_punch`;
DROP TABLE IF EXISTS `attendance_approval_step`;
DROP TABLE IF EXISTS `attendance_approval_request`;
DROP TABLE IF EXISTS `attendance_approval_role`;
