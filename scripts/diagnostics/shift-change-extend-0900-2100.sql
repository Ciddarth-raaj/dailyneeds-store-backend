-- =====================================================================
-- One-day shift change 09:00-18:00 -> 09:00-21:00 is not available.
--
-- READ-ONLY. Nothing here writes. Set @emp and @date to a real failing case
-- (an employee on 09:00-18:00 and the date they tried), run on production,
-- and paste the result sets back.
--
-- It reproduces, in SQL, every input `shiftChangeOptions` and
-- `raiseShiftChangeRequest` decide on - in the order they decide:
--   window -> payroll lock -> existing request -> HR block -> dated base
--   -> requested shift active / has a row that weekday / is_working_day
--   -> NRM(target) > NRM(base), NRM = span - the shift's own break_minutes.
--
-- The engine reads each shift's schedule from its LATEST
-- `work_shift_config_version` document when one exists (else the live
-- `work_shift_weekly_schedule`), so block 5 prints BOTH: a live row that
-- differs from the latest version is itself a finding.
-- =====================================================================

SET @emp  := 0;             -- the employee who could not raise it
SET @date := '2026-09-26';  -- the attendance date they chose
SET @dow  := DAYOFWEEK(@date) - 1;  -- 0 = Sunday .. 6 = Saturday, as the schedule stores it

-- 1. THE EMPLOYEE ----------------------------------------------------------
SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id,
       ne.designation_id, ne.attendance_required, ne.default_work_shift_id
  FROM new_employee ne WHERE ne.employee_id = @emp;

-- 2. THE DATED PERMANENT SHIFT FOR @date (never today's default) ----------
--    The winner is the greatest effective_from <= @date, then greatest id.
SELECT a.employee_work_shift_assignment_id, a.work_shift_id, w.shift_code, w.shift_name,
       DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from, a.source,
       (a.effective_from <= @date) AS on_or_before_date
  FROM employee_work_shift_assignment a
  JOIN work_shift w ON w.work_shift_id = a.work_shift_id
 WHERE a.employee_id = @emp
 ORDER BY a.effective_from, a.employee_work_shift_assignment_id;

-- 3. ANY ONE-DATE OVERRIDE ALREADY ON @date --------------------------------
SELECT * FROM attendance_date_shift_override
 WHERE employee_id = @emp AND attendance_date = @date;

-- 4. EVERY 09:00-start SHIFT, ITS ACTIVE FLAG AND ITS @dow ROW (live) -----
--    NRM = span - break_minutes. `normal_work_minutes` is what the master
--    shows; it must equal nrm_computed.
SELECT w.work_shift_id, w.shift_code, w.shift_name, w.active,
       s.day_of_week, s.is_working_day,
       TIME_FORMAT(s.in_time, '%H:%i') AS in_time, TIME_FORMAT(s.out_time, '%H:%i') AS out_time,
       s.break_minutes, s.normal_work_minutes,
       CASE WHEN s.in_time IS NULL OR s.out_time IS NULL THEN NULL
            WHEN s.out_time > s.in_time THEN TIME_TO_SEC(TIMEDIFF(s.out_time, s.in_time)) / 60
            ELSE (TIME_TO_SEC(TIMEDIFF(s.out_time, s.in_time)) / 60) + 1440 END AS span_minutes,
       CASE WHEN s.in_time IS NULL OR s.out_time IS NULL THEN NULL
            WHEN s.out_time > s.in_time THEN TIME_TO_SEC(TIMEDIFF(s.out_time, s.in_time)) / 60 - s.break_minutes
            ELSE (TIME_TO_SEC(TIMEDIFF(s.out_time, s.in_time)) / 60) + 1440 - s.break_minutes END AS nrm_computed
  FROM work_shift w
  LEFT JOIN work_shift_weekly_schedule s ON s.work_shift_id = w.work_shift_id AND s.day_of_week = @dow
 WHERE EXISTS (SELECT 1 FROM work_shift_weekly_schedule x
                WHERE x.work_shift_id = w.work_shift_id AND TIME_FORMAT(x.in_time, '%H:%i') = '09:00')
 ORDER BY w.active DESC, s.out_time;

-- 5. THE SAME @dow ROW AS THE ENGINE READS IT: the LATEST version document --
SELECT v.work_shift_id, w.shift_code, v.work_shift_config_version_id,
       DATE_FORMAT(v.effective_from, '%Y-%m-%d') AS effective_from, v.source,
       JSON_EXTRACT(v.config_document, CONCAT('$.schedule[', @dow, ']')) AS dow_row_in_version
  FROM work_shift_config_version v
  JOIN work_shift w ON w.work_shift_id = v.work_shift_id
 WHERE v.work_shift_config_version_id = (
         SELECT v2.work_shift_config_version_id FROM work_shift_config_version v2
          WHERE v2.work_shift_id = v.work_shift_id
          ORDER BY v2.effective_from DESC, v2.work_shift_config_version_id DESC LIMIT 1)
   AND EXISTS (SELECT 1 FROM work_shift_weekly_schedule x
                WHERE x.work_shift_id = v.work_shift_id AND TIME_FORMAT(x.in_time, '%H:%i') = '09:00');

-- 6. THE GATES BEFORE THE SHIFT IS NAMED -----------------------------------
--    payroll lock
SELECT employee_id, period_year, period_month, status FROM payrun_employee_calculation
 WHERE employee_id = @emp AND period_year = YEAR(@date) AND period_month = MONTH(@date);
--    one request per date (any non-CANCELLED SHIFT_CHANGE blocks unless REJECTED)
SELECT attendance_approval_request_id, request_type, status, requested_work_shift_id, base_work_shift_id, created_at
  FROM attendance_approval_request
 WHERE requested_for_employee_id = @emp AND attendance_date = @date AND status <> 'CANCELLED';
--    HR block
SELECT * FROM attendance_shift_change_block
 WHERE employee_id = @emp AND attendance_date = @date;

-- 7. EVERY SHIFT_CHANGE REQUEST EVER RAISED FOR A 09:00-21:00 SHIFT -------
--    Were any raised at all, and where are they in the chain? A request that
--    exists but sits on a stage whose approver's branch differs from the
--    request's outlet is invisible in the Shift tab (same defect as 106).
SELECT r.attendance_approval_request_id AS req, r.requested_for_employee_id AS emp,
       DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date, r.status,
       r.outlet_id, bw.shift_code AS base_code, rw.shift_code AS requested_code,
       r.current_stage_no, r.total_stages, s.approver_role, s.approver_employee_id,
       a.store_id AS approver_branch
  FROM attendance_approval_request r
  JOIN work_shift rw ON rw.work_shift_id = r.requested_work_shift_id
  LEFT JOIN work_shift bw ON bw.work_shift_id = r.base_work_shift_id
  LEFT JOIN attendance_approval_step s
    ON s.attendance_approval_request_id = r.attendance_approval_request_id AND s.stage_no = r.current_stage_no
  LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
 WHERE r.request_type = 'SHIFT_CHANGE'
   AND EXISTS (SELECT 1 FROM work_shift_weekly_schedule x
                WHERE x.work_shift_id = r.requested_work_shift_id
                  AND TIME_FORMAT(x.in_time, '%H:%i') = '09:00' AND TIME_FORMAT(x.out_time, '%H:%i') = '21:00')
 ORDER BY r.attendance_approval_request_id DESC
 LIMIT 50;
