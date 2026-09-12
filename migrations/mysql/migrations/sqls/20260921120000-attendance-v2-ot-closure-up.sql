-- Attendance v2 - the finalized OT flow: how an OT claim was CLOSED.
--
-- ADDITIVE ONLY. One nullable column on `attendance_approval_request`; no
-- row is rewritten, no enum value is removed (REGULARIZATION_WITH_OT stays
-- readable for the historical rows that carry it - new code never writes
-- it), no permission changes, and `biomax_punch` is not touched.
--
-- `closure_reason` is set by the payroll lock and by nothing else:
--
--   NOT_REQUESTED_BEFORE_PAYROLL_LOCK  the engine found candidate OT on the
--                                      date and nobody requested it before
--                                      the month was locked: a REJECTED OT
--                                      record is written for the date
--   NOT_APPROVED_BEFORE_PAYROLL_LOCK   the employee requested it and the
--                                      chain had not finished when the month
--                                      was locked: the PENDING request is
--                                      REJECTED
--
-- An ordinary rejection by an approver leaves it NULL. So a REJECTED OT
-- request reads either "OT Rejected" (an approver said no) or the exact
-- closure wording, and the two are never confused.
ALTER TABLE `attendance_approval_request`
  ADD COLUMN `closure_reason` ENUM('NOT_REQUESTED_BEFORE_PAYROLL_LOCK','NOT_APPROVED_BEFORE_PAYROLL_LOCK')
    NULL DEFAULT NULL
    COMMENT 'set by the payroll lock only - NULL for a decision an approver made';
