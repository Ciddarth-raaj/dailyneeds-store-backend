-- =====================================================================
-- Employee 106 is missing from Attendance Approval and OT Approval.
--
-- READ-ONLY. Nothing here writes. Run it on production as it is and paste the
-- result sets back. Only @emp is employee-specific.
--
-- WHAT IT DECIDES, in order. Each block says which result proves which case:
--   A. the request was never created        -> block 2 is empty
--   B. the chain was created wrongly        -> block 3 steps do not match block 4
--   C. the current stage names the wrong    -> block 3's current step is not the
--      approver                                approver in block 4
--   D. the branch scope hides it            -> block 6: outlet_in_scope = 0 for the
--                                              current approver (and block 7 = 0)
--   E. the repository query filters it      -> block 7 shows the exact predicate
--   F. the API returns it, the UI hides it  -> block 7 returns the row for the
--                                              approver; the UI adds no filter by
--                                              default (pages/attendance/approval)
--
-- THE SUSPECTED ROOT CAUSE (D/E): `_approvalScope` in production ANDs a flat
--   r.outlet_id IN (<approver's own store_id>)
-- onto the queue. An approver named in Attendance Approver Setup whose own
-- `new_employee.store_id` differs from 106's `store_id` - or an HR /
-- Operations role holder without `employee_scope_all_branches` - loses the
-- row from the list AND the count, while `canApprove` still lets them
-- decide it (Telegram works; the web queue is empty).
-- =====================================================================

SET @emp := 106;

-- 1. IDENTITY ---------------------------------------------------------------
--    Expect: store_id (the owning branch), designation, attendance_required,
--    works_all_locations = 1 if 106 is the roaming employee.
SELECT ne.employee_id, ne.employee_name, ne.status,
       ne.store_id, o.outlet_name,
       ne.designation_id, d.designation_name,
       ne.attendance_required, ne.works_all_locations,
       ne.default_work_shift_id,
       r.approver_role AS own_approver_role, r.requester_class
  FROM new_employee ne
  LEFT JOIN outlets o ON o.outlet_id = ne.store_id
  LEFT JOIN designation d ON d.designation_id = ne.designation_id
  LEFT JOIN attendance_approval_role r ON r.designation_id = ne.designation_id
 WHERE ne.employee_id = @emp;

-- 2. EVERY REQUEST FOR 106 (A) ------------------------------------------------
SELECT attendance_approval_request_id AS req, request_type, status,
       DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
       outlet_id, requester_class, chain_source,
       current_stage_no, total_stages, finalization_state,
       candidate_ot_minutes, approved_ot_minutes, closure_reason, auto_created,
       requested_by_employee_id, created_at, decided_at
  FROM attendance_approval_request
 WHERE requested_for_employee_id = @emp
 ORDER BY attendance_date DESC, attendance_approval_request_id DESC;

-- 3. EVERY STEP OF THOSE REQUESTS (B, C) -------------------------------------
SELECT s.attendance_approval_request_id AS req, r.request_type, r.status,
       s.stage_no, (s.stage_no = r.current_stage_no) AS is_current,
       s.approver_role, s.outlet_id AS step_outlet_id,
       s.approval_level, s.approver_employee_id, a.employee_name AS approver_name,
       a.store_id AS approver_store_id, a.designation_id AS approver_designation_id,
       s.decision, s.decided_by_employee_id, s.decided_at
  FROM attendance_approval_step s
  JOIN attendance_approval_request r ON r.attendance_approval_request_id = s.attendance_approval_request_id
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
 WHERE r.requested_for_employee_id = @emp
 ORDER BY s.attendance_approval_request_id DESC, s.stage_no;

-- 4. THE APPROVER SETUP THAT APPLIES TO 106 ----------------------------------
SELECT s.*, f.employee_name AS first_name, f.store_id AS first_store,
       sc.employee_name AS second_name, sc.store_id AS second_store,
       fi.employee_name AS final_name, fi.store_id AS final_store
  FROM attendance_approver_setup s
  LEFT JOIN new_employee f ON f.employee_id = s.first_level_approver_employee_id
  LEFT JOIN new_employee sc ON sc.employee_id = s.second_level_approver_employee_id
  LEFT JOIN new_employee fi ON fi.employee_id = s.final_approver_employee_id
 WHERE s.employee_id = @emp;

-- 5. THE CURRENT APPROVER OF EACH PENDING REQUEST, AND WHO CAN SEE IT --------
--    For an employee-level stage it is `approver_employee_id`. For a role
--    stage it is every holder of that role (block 5b).
SELECT r.attendance_approval_request_id AS req, r.request_type,
       r.outlet_id AS request_outlet_id,
       s.approver_role, s.outlet_id AS step_outlet_id, s.approver_employee_id,
       a.employee_name AS approver_name, a.status AS approver_status,
       a.store_id AS approver_branch, u.user_type AS approver_user_type,
       a.designation_id AS approver_designation_id
  FROM attendance_approval_request r
  JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id
   AND s.stage_no = r.current_stage_no
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
  LEFT JOIN `user` u ON u.employee_id = a.employee_id
 WHERE r.requested_for_employee_id = @emp AND r.status = 'PENDING';

-- 5b. Role holders, for role stages.
SELECT ar.approver_role, ne.employee_id, ne.employee_name, ne.store_id, u.user_type
  FROM attendance_approval_role ar
  JOIN new_employee ne ON ne.designation_id = ar.designation_id AND ne.status = 1
  LEFT JOIN `user` u ON u.employee_id = ne.employee_id
 WHERE ar.approver_role IS NOT NULL
 ORDER BY ar.approver_role, ne.employee_id;

-- 6. THE BRANCH SCOPE OF EACH CURRENT APPROVER (D) ---------------------------
--    `middlewares/employee_branch_scope.js`: admin (user_type 2) or the
--    `employee_scope_all_branches` key -> ALL; else OWN = [new_employee.store_id].
SELECT r.attendance_approval_request_id AS req, r.request_type,
       r.outlet_id AS request_outlet_id,
       s.approver_employee_id, a.store_id AS approver_branch, u.user_type,
       EXISTS (SELECT 1 FROM permissions p
                WHERE p.designation_id = a.designation_id AND p.is_active = 1
                  AND p.permission_key = 'employee_scope_all_branches') AS has_all_branches,
       CASE WHEN u.user_type = 2 THEN 1
            WHEN EXISTS (SELECT 1 FROM permissions p
                          WHERE p.designation_id = a.designation_id AND p.is_active = 1
                            AND p.permission_key = 'employee_scope_all_branches') THEN 1
            WHEN a.store_id = r.outlet_id THEN 1
            ELSE 0 END AS outlet_in_scope
  FROM attendance_approval_request r
  JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id
   AND s.stage_no = r.current_stage_no
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
  LEFT JOIN `user` u ON u.employee_id = a.employee_id
 WHERE r.requested_for_employee_id = @emp AND r.status = 'PENDING';

-- 7. THE PRODUCTION QUEUE PREDICATE, EVALUATED (E) ---------------------------
--    Exactly the PENDING scope `listApprovals`/`countApprovals` build for an
--    employee-level approver with no approver role (repository
--    `_approvalScope` at 2bcc37a), one row per pending request of 106, with
--    each conjunct as its own column. `production_visible` = 0 and
--    `authority` = 1 with `branch` = 0 is the defect.
SELECT r.attendance_approval_request_id AS req, r.request_type,
       s.approver_employee_id AS approver,
       (s.approver_employee_id IS NOT NULL) AS authority,
       (r.requested_for_employee_id <> s.approver_employee_id
        AND r.requested_by_employee_id <> s.approver_employee_id) AS not_own,
       (r.outlet_id = a.store_id) AS branch,
       (s.approver_employee_id IS NOT NULL
        AND r.requested_for_employee_id <> s.approver_employee_id
        AND r.requested_by_employee_id <> s.approver_employee_id
        AND (u.user_type = 2 OR r.outlet_id = a.store_id)) AS production_visible,
       (s.approver_employee_id IS NOT NULL
        AND r.requested_for_employee_id <> s.approver_employee_id
        AND r.requested_by_employee_id <> s.approver_employee_id) AS fixed_visible
  FROM attendance_approval_request r
  JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id
   AND s.stage_no = r.current_stage_no
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
  LEFT JOIN `user` u ON u.employee_id = a.employee_id
 WHERE r.requested_for_employee_id = @emp
   AND r.status = 'PENDING' AND s.decision = 'PENDING';

-- 8. THE BLAST RADIUS: every pending request hidden from its named approver --
SELECT COUNT(*) AS hidden_pending,
       COUNT(DISTINCT r.requested_for_employee_id) AS employees,
       SUM(r.request_type = 'REGULARIZATION') AS regularization,
       SUM(r.request_type = 'OT') AS ot,
       SUM(r.request_type = 'SHIFT_CHANGE') AS shift_change
  FROM attendance_approval_request r
  JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id
   AND s.stage_no = r.current_stage_no
  JOIN new_employee a ON a.employee_id = s.approver_employee_id
  LEFT JOIN `user` u ON u.employee_id = a.employee_id
 WHERE r.status = 'PENDING' AND s.decision = 'PENDING'
   AND COALESCE(u.user_type, 0) <> 2
   AND NOT (r.outlet_id <=> a.store_id)
   AND NOT EXISTS (SELECT 1 FROM permissions p
                    WHERE p.designation_id = a.designation_id AND p.is_active = 1
                      AND p.permission_key = 'employee_scope_all_branches');

-- 9. OT FOR 106: what the engine STORED per day, to set against block 2 -------
--    AVAILABLE = candidate/excess > 0 with no OT request; requested = an OT row
--    PENDING; approved/closed from block 2. The live figure for a date comes
--    from GET /attendance/employee/106?from=..&to=.. (calculateRange), which
--    is what the approval screen shows for a PENDING row.
SELECT DATE_FORMAT(c.attendance_date, '%Y-%m-%d') AS attendance_date, c.status,
       c.work_shift_id, c.nrm_minutes, c.base_nrm_minutes, c.worked_minutes,
       c.regular_minutes, c.shortage_minutes, c.candidate_ot_minutes,
       c.shift_authorised_ot_minutes, c.approved_ot_minutes,
       (SELECT GROUP_CONCAT(CONCAT(q.request_type, ':', q.status, '#', q.attendance_approval_request_id))
          FROM attendance_approval_request q
         WHERE q.requested_for_employee_id = c.employee_id
           AND q.attendance_date = c.attendance_date) AS requests
  FROM attendance_day_calculation c
 WHERE c.employee_id = @emp
   AND c.attendance_date >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)
 ORDER BY c.attendance_date DESC;
