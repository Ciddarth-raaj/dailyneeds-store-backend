-- =====================================================================
-- READ-ONLY audit: who is in a payroll month's Initialization population
-- although their employment had not begun by the month's last day.
--
--   mysql --host=<host> --user=<readonly-user> --password <database> \
--         --table < scripts/diagnostics/payrun-future-joiner-audit.sql
--
-- STRICTLY READ-ONLY. Every statement is a SELECT, apart from the three
-- session variables below, which exist only in this connection. No UPDATE,
-- DELETE, INSERT, ALTER, CREATE or temporary table. Safe against production.
--
-- The month is September 2026. Change @y/@m to audit any other month; @from
-- and @to are derived from them.
--
-- The joining-date expression is `utils/joining_date.js#JOINED_ON`, verbatim,
-- because it is what `repository/payrun.js#listPopulation` - the population
-- behind Total Eligible, Ready, Blocked, Initialized, Attendance Pending and
-- the Initialize action itself - reads today.
-- =====================================================================

SET @y := 2026, @m := 9;
SET @from := STR_TO_DATE(CONCAT(@y, '-', @m, '-01'), '%Y-%m-%d');
SET @to   := LAST_DAY(@from);

SELECT @from AS month_from, @to AS month_to, @@lc_time_names AS lc_time_names_must_be_en_US,
       @@time_zone AS time_zone;

-- ================================== 1. employee 2298: every stored fact ====
-- 1a. the master row, raw and parsed. `date_of_joining_raw` is printed as
--     stored so a NULL, a blank or a zero date is visible as such.
SELECT ne.employee_id, ne.employee_name, ne.status,
       ne.date_of_joining                      AS date_of_joining_raw,
       (CASE
          WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
          WHEN ne.date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y')
        END)                                   AS joined_on_as_payroll_reads_it,
       ne.resignation_date, ne.store_id, ne.designation_id, ne.payment_type,
       ne.pf_applicable, ne.esi_applicable, ne.created_at, ne.updated_at
  FROM new_employee ne
 WHERE ne.employee_id = 2298;

-- 1b. every employment period (C1 lifecycle) - the effective-dated record.
SELECT period_id, period_no, period_state, joined_on, ended_on, end_reason_type,
       source, needs_review, created_at, updated_at
  FROM employee_employment_period
 WHERE employee_id = 2298
 ORDER BY period_no;

-- 1c. lifecycle events (create / rejoin / resign / date corrections).
SELECT event_id, period_id, event_type, actor_employee_id, detail_json, created_at
  FROM employee_lifecycle_event
 WHERE employee_id = 2298
 ORDER BY event_id;

-- 1d. resignation records.
SELECT * FROM resignation WHERE employee_id = 2298;

-- 1e. salary rows (BLOCKED is expected to be "salary not approved" for September).
SELECT salary_id, status, effective_from, monthly_gross, created_at
  FROM employee_salary
 WHERE employee_id = 2298
 ORDER BY effective_from, salary_id;

-- 1f. September attendance roll-up (PENDING · 1 is expected to be "no attendance month").
SELECT employee_id, period_year, period_month, is_final, updated_at
  FROM attendance_monthly_payroll
 WHERE employee_id = 2298 AND period_year = @y AND period_month = @m;

-- 1g. any payrun snapshot for 2298, in any month.
SELECT payrun_employee_id, period_year, period_month, status, date_of_joining,
       resignation_date, monthly_gross, attendance_closed_for_payroll,
       initialized_at, initialized_by
  FROM payrun_employee
 WHERE employee_id = 2298;

-- ============== 2. everybody in the month's population who joined later ====
-- The population predicate of `listPopulation`, side by side with the
-- employment period, for every employee whose employment, by ANY stored
-- source, began after @to - or whose payroll-read joining date is unknown
-- while the lifecycle or the record itself says they started after @to.
SELECT ne.employee_id, ne.employee_name, ne.status,
       ne.date_of_joining AS date_of_joining_raw,
       j.joined_on        AS joined_on_as_payroll_reads_it,
       p.period_no        AS latest_period_no,
       p.joined_on        AS latest_period_joined_on,
       p.needs_review     AS latest_period_needs_review,
       ne.resignation_date, ne.created_at,
       (pe.payrun_employee_id IS NOT NULL) AS has_snapshot_for_month
  FROM new_employee ne
  JOIN (SELECT employee_id,
               (CASE
                  WHEN date_of_joining IS NULL OR TRIM(date_of_joining) = '' THEN NULL
                  WHEN date_of_joining LIKE '____-__-__%'
                       AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                    THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
                  ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
                END) AS joined_on
          FROM new_employee) j ON j.employee_id = ne.employee_id
  LEFT JOIN employee_employment_period p
         ON p.employee_id = ne.employee_id
        AND p.period_no = (SELECT MAX(period_no) FROM employee_employment_period x
                            WHERE x.employee_id = ne.employee_id)
  LEFT JOIN payrun_employee pe
         ON pe.employee_id = ne.employee_id AND pe.period_year = @y AND pe.period_month = @m
 WHERE (ne.resignation_date IS NULL OR ne.resignation_date >= @from)   -- in listPopulation today
   AND (j.joined_on IS NULL OR j.joined_on <= @to)                     -- in listPopulation today
   AND (   p.joined_on > @to
        OR j.joined_on IS NULL AND ne.created_at > @to + INTERVAL 1 DAY
        OR YEAR(j.joined_on) = 0)
 ORDER BY ne.employee_id;

-- ===================================== 3. what the September counters are ==
-- Recomputes the population size under today's rule and under the corrected
-- rule (an employment period that starts after the month excludes the
-- employee), plus the snapshot count, which is stored and does not move.
SELECT
  COUNT(*) AS population_today,
  SUM(NOT (p.joined_on IS NOT NULL AND p.joined_on > @to)) AS population_after_fix,
  SUM(pe.payrun_employee_id IS NOT NULL) AS initialized_snapshots_in_population,
  SUM(pe.payrun_employee_id IS NOT NULL AND p.joined_on > @to) AS future_joiners_with_snapshot
  FROM new_employee ne
  JOIN (SELECT employee_id,
               (CASE
                  WHEN date_of_joining IS NULL OR TRIM(date_of_joining) = '' THEN NULL
                  WHEN date_of_joining LIKE '____-__-__%'
                       AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                    THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
                  ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
                END) AS joined_on
          FROM new_employee) j ON j.employee_id = ne.employee_id
  LEFT JOIN employee_employment_period p
         ON p.employee_id = ne.employee_id
        AND p.period_no = (SELECT MAX(period_no) FROM employee_employment_period x
                            WHERE x.employee_id = ne.employee_id)
  LEFT JOIN payrun_employee pe
         ON pe.employee_id = ne.employee_id AND pe.period_year = @y AND pe.period_month = @m
 WHERE (ne.resignation_date IS NULL OR ne.resignation_date >= @from)
   AND (j.joined_on IS NULL OR j.joined_on <= @to);

-- All stored September snapshots, with the joining date each one captured.
SELECT COUNT(*) AS snapshots_total,
       SUM(date_of_joining > @to) AS snapshots_captured_with_doj_after_month,
       SUM(attendance_closed_for_payroll = 1) AS closed_for_payroll
  FROM payrun_employee
 WHERE period_year = @y AND period_month = @m;
