-- Attendance OT: AUTO-APPROVAL.
--
-- ADDITIVE ONLY. Two columns on the one-row automatic-OT setting.
--
-- `auto_approve` = 1: nobody decides OT. A sweep (every five minutes) approves
-- every PENDING OT through the ordinary decision path, as the system: the
-- step is APPROVED with no decider and remarks saying so. A pending
-- correction, an incomplete or open day, and the clamp to the engine's
-- eligible OT all still apply. OT in a payroll-LOCKED month is never
-- approved by the system - it pays as Prior-Month OT - and stays with people.
--
-- `auto_approve_max_minutes`: OT longer than this stays with approvers.
-- NULL = no cap.
--
-- Switched ON with no cap here, as asked. `auto_approve` = 0 turns it off at
-- once; nothing already approved is undone.
ALTER TABLE `attendance_ot_auto_pending_setting`
  ADD COLUMN `auto_approve` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = the system approves pending OT (not in a locked payroll month)',
  ADD COLUMN `auto_approve_max_minutes` INT NULL
    COMMENT 'OT longer than this stays with approvers; NULL = no cap';

UPDATE `attendance_ot_auto_pending_setting`
   SET `auto_approve` = 1, `auto_approve_max_minutes` = NULL
 WHERE `setting_id` = 1;
