-- Attendance OT: auto-approval switched OFF, as asked.
--
-- The five-minute sweep stops approving, and newly raised OT goes back to its
-- approval chain with the first approver's Telegram card. Nothing the system
-- already approved is undone. `auto_approve` = 1 switches it back on.
UPDATE `attendance_ot_auto_pending_setting`
   SET `auto_approve` = 0
 WHERE `setting_id` = 1;
