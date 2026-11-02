-- Attendance OT: auto-approval becomes a SCREEN SETTING (Attendance -> OT
-- Auto-Approval) instead of a migration.
--
-- ADDITIVE ONLY. One audit column on the one-row automatic-OT setting, and one
-- permission key.

-- 1. Who last changed the switch or the cap (`updated_at` already says when).
ALTER TABLE `attendance_ot_auto_pending_setting`
  ADD COLUMN `auto_approve_updated_by` INT NULL
    COMMENT 'employee who last saved OT Auto-Approval';

-- 2. The permission key. DECLARED and granted to NOBODY: administrators hold
--    it through the user_type 2 bypass; a designation gets it only when
--    somebody grants it on the Designation screen.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_ot_auto_approval' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'manage_ot_auto_approval');
