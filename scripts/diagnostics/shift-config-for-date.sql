-- READ-ONLY. What break allowance and pre-shift OT setting a given employee's
-- attendance date was (and would now be) calculated under.
--
--   Set the two variables, then run every statement. Nothing is written.
--
-- 1. The STORED day row: the exact configuration the date was calculated
--    under (`shift_snapshot`), and the allowance actually applied (which
--    includes any employee override / Extra Break Hours).
-- 2. The LIVE shift master + weekly row (what a recalculation would read
--    when the shift has no version history).
-- 3. The newest config VERSION (what a recalculation reads today -
--    `utils/shift_config_version.js#configVersionForCalculation`).
-- 4. The employee's own break settings.

SET @employee_id = 0;            -- <- the employee
SET @attendance_date = '2026-09-12';

-- 1 ---------------------------------------------------------------------------
SELECT c.employee_id, c.attendance_date, c.work_shift_id, c.status,
       c.break_allowance_minutes, c.break_allowance_source,
       c.break_override_minutes_applied, c.extra_break_minutes_applied,
       c.break_charged_minutes, c.worked_minutes,
       c.candidate_ot_minutes, c.approved_ot_minutes,
       JSON_UNQUOTE(JSON_EXTRACT(c.shift_snapshot, '$.in_time'))                    AS snap_in_time,
       JSON_UNQUOTE(JSON_EXTRACT(c.shift_snapshot, '$.out_time'))                   AS snap_out_time,
       JSON_EXTRACT(c.shift_snapshot, '$.break_minutes')                            AS snap_break_minutes,
       JSON_EXTRACT(c.shift_snapshot, '$.pre_shift_overtime_allowed')               AS snap_pre_shift_ot_allowed,
       JSON_EXTRACT(c.shift_snapshot, '$.pre_shift_overtime_minimum_minutes')       AS snap_pre_shift_ot_minimum,
       JSON_EXTRACT(c.shift_snapshot, '$.overtime_allowed')                         AS snap_ot_allowed,
       c.shift_snapshot
  FROM attendance_day_calculation c
 WHERE c.employee_id = @employee_id AND c.attendance_date = @attendance_date;

-- 2 ---------------------------------------------------------------------------
SELECT ws.work_shift_id, ws.shift_code, ws.shift_name,
       ws.overtime_allowed, ws.pre_shift_overtime_allowed, ws.pre_shift_overtime_minimum_minutes,
       ws.overtime_minimum_minutes, ws.overtime_rounding_method,
       d.day_of_week, d.in_time, d.out_time, d.break_minutes, d.normal_work_minutes, d.ot_rate
  FROM work_shift ws
  JOIN work_shift_weekly_schedule d ON d.work_shift_id = ws.work_shift_id
 WHERE ws.work_shift_id = (SELECT work_shift_id FROM attendance_day_calculation
                            WHERE employee_id = @employee_id AND attendance_date = @attendance_date)
   AND d.day_of_week = DAYOFWEEK(@attendance_date) - 1;

-- 3 ---------------------------------------------------------------------------
SELECT v.work_shift_config_version_id, v.effective_from, v.source, v.created_at,
       JSON_EXTRACT(v.config_document, '$.pre_shift_overtime_allowed') AS pre_shift_ot_allowed,
       v.config_document
  FROM work_shift_config_version v
 WHERE v.work_shift_id = (SELECT work_shift_id FROM attendance_day_calculation
                           WHERE employee_id = @employee_id AND attendance_date = @attendance_date)
 ORDER BY v.effective_from DESC, v.work_shift_config_version_id DESC
 LIMIT 1;

-- 4 ---------------------------------------------------------------------------
SELECT employee_id, employee_name, special_break_override_minutes, extra_break_hours
  FROM new_employee
 WHERE employee_id = @employee_id;
