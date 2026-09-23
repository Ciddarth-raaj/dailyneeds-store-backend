-- =====================================================================
-- Employee 106 (Kumaraguru) missing from Attendance / OT Approval, and the
-- 09:00-18:00 -> 09:00-21:00 one-day shift change.
--
-- READ-ONLY. Every statement is a SELECT. Run as a read-only DB user, or
-- after `SET SESSION TRANSACTION READ ONLY;`.
--
-- Set the variables first. @emp is the employee whose requests are missing;
-- @d is the attendance date the report was about (leave NULL for "all").
-- @shift_emp / @shift_date / @target_shift are the shift-change case.
-- =====================================================================
SET SESSION TRANSACTION READ ONLY;
SET @emp := 106;
SET @d := NULL;              -- e.g. '2026-09-20'
SET @shift_emp := NULL;      -- the staff member asking for 09:00-21:00
SET @shift_date := NULL;     -- the date they asked for, 'YYYY-MM-DD'
SET @target_shift := NULL;   -- work_shift_id of the 09:00-21:00 shift

-- 1. IDENTITY -----------------------------------------------------------
--    outlet (store_id), designation, attendance_required, status.
SELECT ne.employee_id, ne.employee_name, ne.store_id AS outlet_id, o.outlet_name,
       ne.designation_id, d.designation_name, ne.status, ne.attendance_required,
       ne.default_work_shift_id,
       aar.approver_role AS own_approver_role, aar.requester_class
  FROM new_employee ne
  LEFT JOIN outlets o ON o.outlet_id = ne.store_id
  LEFT JOIN designation d ON d.designation_id = ne.designation_id
  LEFT JOIN attendance_approval_role aar ON aar.designation_id = ne.designation_id
 WHERE ne.employee_id = @emp;

-- 2. ATTENDANCE APPROVER SETUP for @emp, with each approver's OWN branch.
--    A named approver whose store_id differs from @emp's is the shape the
--    approval centre used to hide (branch scope applied to a step that names
--    them). `has_all_branches` = their designation holds
--    employee_scope_all_branches (HR), which was never hidden.
SELECT s.employee_id, s.is_active,
       s.first_level_approver_employee_id  AS first_id,  f.store_id  AS first_outlet,
       EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = f.designation_id
                 AND p.is_active = 1 AND p.permission_key = 'employee_scope_all_branches') AS first_all_branches,
       s.second_level_approver_employee_id AS second_id, sc.store_id AS second_outlet,
       EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = sc.designation_id
                 AND p.is_active = 1 AND p.permission_key = 'employee_scope_all_branches') AS second_all_branches,
       s.final_approver_employee_id        AS final_id,  fi.store_id AS final_outlet,
       EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = fi.designation_id
                 AND p.is_active = 1 AND p.permission_key = 'employee_scope_all_branches') AS final_all_branches
  FROM attendance_approver_setup s
  LEFT JOIN new_employee f  ON f.employee_id  = s.first_level_approver_employee_id
  LEFT JOIN new_employee sc ON sc.employee_id = s.second_level_approver_employee_id
  LEFT JOIN new_employee fi ON fi.employee_id = s.final_approver_employee_id
 WHERE s.employee_id = @emp;

-- 3. THE REQUESTS (A: were they ever created?) --------------------------
SELECT r.attendance_approval_request_id, r.request_type, r.status,
       DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
       r.outlet_id AS request_outlet_id, r.current_stage_no, r.total_stages,
       r.chain_source, r.requester_class, r.candidate_ot_minutes,
       r.approved_ot_minutes, r.finalization_state, r.closure_reason,
       r.auto_created, r.requested_by_employee_id, r.created_at, r.decided_at
  FROM attendance_approval_request r
 WHERE r.requested_for_employee_id = @emp
   AND r.request_type IN ('REGULARIZATION','REGULARIZATION_WITH_OT','OT')
   AND (@d IS NULL OR r.attendance_date = @d)
 ORDER BY r.attendance_date DESC, r.attendance_approval_request_id DESC;

-- 4. EVERY STEP (B/C: was the chain built right, where does it point?) ---
--    `is_current` marks the step `listApprovals` joins on.
SELECT s.attendance_approval_request_id, r.request_type, s.stage_no,
       (s.stage_no = r.current_stage_no) AS is_current,
       s.approver_role, s.approval_level, s.approver_employee_id,
       a.employee_name AS approver_name, a.store_id AS approver_outlet_id,
       s.outlet_id AS step_outlet_id, s.decision, s.decided_by_employee_id,
       s.decided_at, s.acted_as_admin_override
  FROM attendance_approval_step s
  JOIN attendance_approval_request r ON r.attendance_approval_request_id = s.attendance_approval_request_id
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
 WHERE r.requested_for_employee_id = @emp
   AND r.request_type IN ('REGULARIZATION','REGULARIZATION_WITH_OT','OT')
   AND (@d IS NULL OR r.attendance_date = @d)
 ORDER BY s.attendance_approval_request_id DESC, s.stage_no;

-- 5. D/E: WOULD THE CURRENT APPROVER SEE IT? ------------------------------
--    For each PENDING request, the current step's approver and the two
--    branch predicates. `old_visible` is production's pre-fix predicate
--    (r.outlet_id IN approver's branches); `new_visible` adds "or the step
--    names this approver". old_visible = 0 AND new_visible = 1 is case D/E.
--    An approver with the all-branches key (HR) was never branch-scoped.
SELECT r.attendance_approval_request_id, r.request_type,
       DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
       r.outlet_id AS request_outlet_id,
       s.approver_employee_id AS current_approver, a.store_id AS approver_outlet_id,
       EXISTS (SELECT 1 FROM permissions p
                WHERE p.designation_id = a.designation_id AND p.is_active = 1
                  AND p.permission_key = 'employee_scope_all_branches') AS approver_all_branches,
       (EXISTS (SELECT 1 FROM permissions p
                 WHERE p.designation_id = a.designation_id AND p.is_active = 1
                   AND p.permission_key = 'employee_scope_all_branches')
        OR r.outlet_id = a.store_id) AS old_visible,
       (EXISTS (SELECT 1 FROM permissions p
                 WHERE p.designation_id = a.designation_id AND p.is_active = 1
                   AND p.permission_key = 'employee_scope_all_branches')
        OR r.outlet_id = a.store_id
        OR s.approver_employee_id IS NOT NULL) AS new_visible
  FROM attendance_approval_request r
  JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id
   AND s.stage_no = r.current_stage_no
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
 WHERE r.requested_for_employee_id = @emp
   AND r.status = 'PENDING' AND s.decision = 'PENDING'
   AND r.request_type IN ('REGULARIZATION','REGULARIZATION_WITH_OT','OT');

-- 6. BLAST RADIUS: every PENDING request hidden from its named approver ---
SELECT r.request_type, COUNT(*) AS hidden_pending,
       COUNT(DISTINCT r.requested_for_employee_id) AS employees,
       COUNT(DISTINCT s.approver_employee_id) AS approvers
  FROM attendance_approval_request r
  JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id
   AND s.stage_no = r.current_stage_no
  JOIN new_employee a ON a.employee_id = s.approver_employee_id
 WHERE r.status = 'PENDING' AND s.decision = 'PENDING'
   AND (a.store_id IS NULL OR r.outlet_id IS NULL OR r.outlet_id <> a.store_id)
   AND NOT EXISTS (SELECT 1 FROM permissions p
                    WHERE p.designation_id = a.designation_id AND p.is_active = 1
                      AND p.permission_key = 'employee_scope_all_branches')
 GROUP BY r.request_type;

-- 7. THE STORED DAY(S) - is OT AVAILABLE / requested / approved? ---------
--    (A stored row may be stale for an open month; the live figure is what
--    `calculateRange` returns, which the approval screen shows for PENDING.)
SELECT DATE_FORMAT(c.attendance_date, '%Y-%m-%d') AS attendance_date, c.status,
       c.work_shift_id, c.nrm_minutes, c.base_nrm_minutes, c.worked_minutes,
       c.regular_minutes, c.shortage_minutes, c.candidate_ot_minutes,
       c.effective_punches
  FROM attendance_day_calculation c
 WHERE c.employee_id = @emp
   AND (@d IS NULL OR c.attendance_date = @d)
 ORDER BY c.attendance_date DESC
 LIMIT 40;

-- =====================================================================
-- THE SHIFT CHANGE CASE
-- =====================================================================

-- 8. The dated permanent shift history for the employee (the base is the
--    row with the greatest effective_from <= the date, NOT default_work_shift_id).
SELECT employee_work_shift_assignment_id, work_shift_id,
       DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from, source
  FROM employee_work_shift_assignment
 WHERE employee_id = @shift_emp
 ORDER BY effective_from, employee_work_shift_assignment_id;

-- 9. The weekly schedule of every 09:00-start shift, live, with span/NRM
--    per weekday (0 = Sunday). `active` must be 1 to be offered.
SELECT ws.work_shift_id, ws.shift_code, ws.shift_name, ws.active,
       w.day_of_week, w.is_working_day,
       TIME_FORMAT(w.in_time, '%H:%i') AS in_time, TIME_FORMAT(w.out_time, '%H:%i') AS out_time,
       w.break_minutes, w.normal_work_minutes,
       (TIME_TO_SEC(TIMEDIFF(w.out_time, w.in_time)) / 60) AS span_minutes,
       (TIME_TO_SEC(TIMEDIFF(w.out_time, w.in_time)) / 60) - w.break_minutes AS computed_nrm
  FROM work_shift ws
  JOIN work_shift_weekly_schedule w ON w.work_shift_id = ws.work_shift_id
 WHERE TIME_FORMAT(w.in_time, '%H:%i') = '09:00'
   AND TIME_FORMAT(w.out_time, '%H:%i') IN ('18:00','21:00')
 ORDER BY ws.work_shift_id, w.day_of_week;

-- 10. The config VERSIONS of the same shifts. The calculation (and the
--     eligibility NRM) reads the LATEST version document, not the live
--     rows above - a version whose schedule disagrees with the live table
--     (break, in/out, is_working_day) is what the engine will use.
SELECT v.work_shift_id, v.work_shift_config_version_id,
       DATE_FORMAT(v.effective_from, '%Y-%m-%d') AS effective_from, v.source,
       v.config_document
  FROM work_shift_config_version v
 WHERE v.work_shift_id IN (
         SELECT DISTINCT w.work_shift_id FROM work_shift_weekly_schedule w
          WHERE TIME_FORMAT(w.in_time, '%H:%i') = '09:00'
            AND TIME_FORMAT(w.out_time, '%H:%i') IN ('18:00','21:00'))
 ORDER BY v.work_shift_id, v.effective_from, v.work_shift_config_version_id;

-- 11. Everything that gates the request for that date.
SELECT 'existing_shift_request' AS gate, r.attendance_approval_request_id AS ref, r.status AS detail
  FROM attendance_approval_request r
 WHERE r.requested_for_employee_id = @shift_emp AND r.attendance_date = @shift_date
   AND r.request_type = 'SHIFT_CHANGE' AND r.status <> 'CANCELLED'
UNION ALL
SELECT 'hr_block', b.attendance_shift_change_block_id, b.reason
  FROM attendance_shift_change_block b
 WHERE b.employee_id = @shift_emp AND b.attendance_date = @shift_date AND b.removed_at IS NULL
UNION ALL
SELECT 'date_override', o.attendance_date_shift_override_id, o.work_shift_id
  FROM attendance_date_shift_override o
 WHERE o.employee_id = @shift_emp AND o.attendance_date = @shift_date
UNION ALL
SELECT 'raise_permission', ne.designation_id,
       IF(EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = ne.designation_id
                   AND p.is_active = 1 AND p.permission_key = 'raise_shift_change_request'),
          'granted', 'MISSING - the options and submit endpoints answer 403')
  FROM new_employee ne WHERE ne.employee_id = @shift_emp;
