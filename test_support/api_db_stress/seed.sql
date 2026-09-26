-- Seed for the API stress harness (test database only).
-- 300 employees on one 09:00-18:00 shift with a 04:00 attendance-day cutoff,
-- two device punches per employee per day for 2026-08-01 .. 2026-09-25, so a
-- My Attendance month read returns real days and real punches.
SET @shift_id = 9001;
DELETE FROM biomax_punch_derived WHERE biomax_punch_id IN (SELECT biomax_punch_id FROM biomax_punch WHERE dev_id = 'STRESS00001');
DELETE FROM biomax_punch WHERE dev_id = 'STRESS00001';
DELETE FROM employee_work_shift_assignment WHERE work_shift_id = @shift_id;
DELETE FROM `user` WHERE username LIKE 'stress%';
DELETE FROM new_employee WHERE employee_id BETWEEN 50001 AND 50300;
DELETE FROM work_shift_weekly_schedule WHERE work_shift_id = @shift_id;
DELETE FROM work_shift WHERE work_shift_id = @shift_id;

INSERT INTO work_shift (work_shift_id, shift_code, shift_name) VALUES (@shift_id, 'STRESS', 'Stress 09-18');
INSERT INTO work_shift_weekly_schedule (work_shift_id, day_of_week, is_working_day, in_time, out_time, attendance_day_cutoff, break_minutes, normal_work_minutes)
SELECT @shift_id, d, 1, '09:00:00', '18:00:00', '04:00:00', 60, 480 FROM (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) x;

INSERT INTO new_employee (employee_id, employee_name, store_id, department_id, designation_id, default_work_shift_id)
SELECT 50000 + seq, CONCAT('Stress ', seq), 1, 1, 1, @shift_id FROM seq_1_to_300;

INSERT INTO employee_work_shift_assignment (employee_id, work_shift_id, effective_from, source)
SELECT 50000 + seq, @shift_id, '2026-08-01', 'ASSIGNMENT' FROM seq_1_to_300;

-- In 09:0x, out 18:0x, every day, every employee.
INSERT INTO biomax_punch (dev_id, user_id, io_time_raw, io_time, raw_json, ingest_source)
SELECT 'STRESS00001', CAST(50000 + e.seq AS CHAR),
       DATE_FORMAT(t.ts, '%Y%m%d%H%i%s'), t.ts, '{}', 'LIVE'
  FROM seq_1_to_300 e
  JOIN (SELECT TIMESTAMP('2026-08-01') + INTERVAL d.seq DAY + INTERVAL h.h HOUR + INTERVAL (d.seq % 7) MINUTE AS ts
          FROM seq_0_to_55 d JOIN (SELECT 9 h UNION SELECT 18) h) t;

INSERT INTO biomax_punch_derived (biomax_punch_id, attendance_date, derivation_status, employee_id, work_shift_id, derived_at)
SELECT biomax_punch_id, DATE(io_time), 'OK', CAST(user_id AS UNSIGNED), @shift_id, NOW(3)
  FROM biomax_punch WHERE dev_id = 'STRESS00001';

-- 50 ordinary login users (employees 50001..50050), IP-unrestricted so the
-- harness's 127.0.0.1 is allowed; the auth middleware still does its real
-- per-user session + IP-policy lookups (cached 60 s) against this table.
DELETE FROM `user` WHERE username LIKE 'stress%';
INSERT INTO `user` (user_id, username, user_type, employee_id, ip_policy, status)
SELECT 60000 + seq, CONCAT('stress', seq), 1, 50000 + seq, 'unrestricted', 1 FROM seq_1_to_50;
UPDATE new_employee SET status = 1 WHERE employee_id BETWEEN 50001 AND 50300;
