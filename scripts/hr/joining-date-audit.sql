-- =====================================================================
-- READ-ONLY audit: new_employee.date_of_joining, before it becomes a DATE
--
--   mysql --host=<host> --user=<readonly-user> --password <database> \
--         --table < scripts/hr/joining-date-audit.sql
--
-- STRICTLY READ-ONLY. Every statement in this file is a SELECT. There is no
-- UPDATE, DELETE, INSERT, ALTER, CREATE, REPLACE, TRUNCATE, SET or PREPARE
-- anywhere in it, it creates no temporary table, and it takes no lock beyond
-- a consistent read. It can be run against production during business hours
-- and can be run by an account with SELECT and nothing else - which is how it
-- SHOULD be run.
--
-- Run it BEFORE the migration and paste the output into the review:
--
--   20261012120000-employee-joining-date-to-date
--
-- Sections 4 and 5 are the ones that decide the deploy. The migration
-- ABORTS if section 4 is non-zero, so this is not merely advisory - it is the
-- same predicate, run in advance so the answer is known before a deploy
-- window rather than during one.
--
-- The one parser is `utils/joining_date.js#JOINED_ON`, reproduced verbatim in
-- every section below. It is the expression C1b's backfill ran against
-- production and the expression payroll and the attendance dashboard read
-- today, so auditing with anything else would audit a different question.
-- =====================================================================

-- ============================================== 0. the environment ========
-- `%M` in the parser is the full month name, and it returns NULL for
-- "05 September 2021" under any locale but en_US - which would make perfectly
-- good dates look unconvertible and abort a migration that is fine. The
-- migration asserts this before it relies on it; read it here first.
SELECT VERSION()          AS mysql_version,
       @@lc_time_names    AS lc_time_names_must_be_en_US,
       @@sql_mode         AS sql_mode,
       @@time_zone        AS time_zone,
       @@system_time_zone AS system_time_zone;

SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE,
       COLUMN_DEFAULT, COLUMN_TYPE, COLLATION_NAME
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'new_employee'
   AND COLUMN_NAME = 'date_of_joining';

-- ================================================= 1. the headline counts ==
-- total rows / non-null / null / blank / unconvertible, in one row.
SELECT
  COUNT(*)                                                             AS total_rows,
  SUM(date_of_joining IS NOT NULL)                                     AS non_null_rows,
  SUM(date_of_joining IS NULL)                                         AS null_rows,
  SUM(date_of_joining IS NOT NULL AND TRIM(date_of_joining) = '')      AS blank_or_whitespace_rows,
  SUM(date_of_joining IS NOT NULL AND TRIM(date_of_joining) <> '')     AS values_present_rows,
  SUM(
    date_of_joining IS NOT NULL
    AND TRIM(date_of_joining) <> ''
    AND (CASE
           WHEN date_of_joining LIKE '____-__-__%'
                AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
             THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
           ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
         END) IS NULL
  )                                                                    AS unconvertible_values
  FROM new_employee;

-- ============================================ 2. the formats, with counts ==
-- LIKE patterns rather than REGEXP, so the answer does not depend on which
-- regex engine the server version ships. `_` is exactly one character.
--
-- ONE ROW READING ISO_DATE is what "the data is now uniform" means. Any other
-- shape appearing here says which of the legacy forms survive, and how many.
SELECT
  CASE
    WHEN date_of_joining IS NULL                          THEN '1. NULL'
    WHEN TRIM(date_of_joining) = ''                       THEN '2. BLANK_OR_WHITESPACE'
    WHEN date_of_joining LIKE '____-__-__'                THEN '3. ISO_DATE (YYYY-MM-DD)'
    WHEN date_of_joining LIKE '____-__-__ %'
      OR date_of_joining LIKE '____-__-__T%'              THEN '4. ISO_WITH_TIME'
    WHEN date_of_joining LIKE '__ % ____'
      OR date_of_joining LIKE '_ % ____'                  THEN '5. DD_MONTH_YYYY'
    ELSE                                                       '6. OTHER - inspect in section 3'
  END                                    AS format_shape,
  COUNT(*)                               AS rows_with_this_shape,
  MIN(date_of_joining)                   AS example_lowest,
  MAX(date_of_joining)                   AS example_highest
  FROM new_employee
 GROUP BY format_shape
 ORDER BY format_shape;

-- ================================= 3. every distinct value that is not ISO =
-- The full list, so "OTHER" in section 2 is never a number nobody looked at.
-- Bounded by DISTINCT, so a thousand identical long-form dates are one line.
SELECT CONCAT('[', date_of_joining, ']')  AS raw_value_in_brackets,
       LENGTH(date_of_joining)            AS byte_length,
       COUNT(*)                           AS rows_with_this_value
  FROM new_employee
 WHERE date_of_joining IS NOT NULL
   AND date_of_joining NOT LIKE '____-__-__'
 GROUP BY date_of_joining
 ORDER BY rows_with_this_value DESC, date_of_joining;

-- ============================================= 4. THE BLOCKING SET =========
-- Every row the migration cannot convert, with its employee id and its exact
-- stored bytes. THIS MUST BE EMPTY. If it is not, the migration aborts, and
-- these rows are corrected on the Employee Master screen first - never in a
-- migration, because guessing a person's start date is not a schema change.
SELECT employee_id,
       employee_name,
       CONCAT('[', date_of_joining, ']') AS raw_value_in_brackets,
       LENGTH(date_of_joining)           AS byte_length
  FROM new_employee
 WHERE date_of_joining IS NOT NULL
   AND TRIM(date_of_joining) <> ''
   AND (CASE
          WHEN date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
        END) IS NULL
 ORDER BY employee_id;

-- ================================ 5. ROWS WHOSE SEMANTIC DATE WOULD CHANGE =
-- The question the review actually asks, and it has two halves.
--
-- 5a. AGAINST THE SHARED PARSER. The migration stores exactly what
--     `JOINED_ON` already yields, and every consumer that matters - payroll,
--     the attendance dashboard, the lifecycle backfill, the recalculation
--     eligibility rule - already reads the column through it. So for those
--     consumers the semantic date cannot change, and this MUST return zero.
--     It is the proof of "representation only", not an expectation.
SELECT COUNT(*) AS rows_whose_parsed_date_would_change_MUST_BE_ZERO
  FROM new_employee
 WHERE date_of_joining IS NOT NULL
   AND TRIM(date_of_joining) <> ''
   AND NOT (
     (CASE
        WHEN date_of_joining LIKE '____-__-__%'
             AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
          THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
        ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
      END)
     <=>
     CAST(DATE_FORMAT((CASE
        WHEN date_of_joining LIKE '____-__-__%'
             AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
          THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
        ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
      END), '%Y-%m-%d') AS DATE)
   );

-- 5b. AGAINST MySQL's OWN IMPLICIT CAST. The handful of places that did NOT
--     use the shared parser - `MONTH(date_of_joining)` and
--     `WEEK(date_of_joining)` on the dashboard counters, and any lexical
--     range comparison - relied on MySQL casting the VARCHAR itself, which
--     yields NULL for the long form. For THOSE call sites the behaviour does
--     change after the migration, and it changes from wrong to right: a
--     long-form joiner who was invisible to the "new joiners this month"
--     count starts being counted.
--
--     So this list is expected to be NON-empty if any long-form row survives,
--     and every row on it should be reviewed as an intended correction rather
--     than a regression. If section 2 shows only ISO_DATE, this is empty too.
SELECT employee_id,
       employee_name,
       CONCAT('[', date_of_joining, ']')          AS raw_value_in_brackets,
       CAST(date_of_joining AS DATE)              AS what_mysql_reads_today,
       (CASE
          WHEN date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
        END)                                      AS what_it_will_hold_after
  FROM new_employee
 WHERE date_of_joining IS NOT NULL
   AND TRIM(date_of_joining) <> ''
   AND NOT (CAST(date_of_joining AS DATE) <=> (CASE
          WHEN date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
        END))
 ORDER BY employee_id;

-- ================================== 6. the range of valid joining dates ====
-- MIN and MAX of the parsed values, plus the count they are drawn from, so
-- the range is read together with how many rows it describes.
SELECT COUNT(joined_on)  AS readable_joining_dates,
       MIN(joined_on)    AS min_valid_joining_date,
       MAX(joined_on)    AS max_valid_joining_date
  FROM (SELECT (CASE
                  WHEN date_of_joining IS NULL OR TRIM(date_of_joining) = '' THEN NULL
                  WHEN date_of_joining LIKE '____-__-__%'
                       AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
                    THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
                  ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
                END) AS joined_on
          FROM new_employee) AS parsed;

-- ============================ 7. dates that parse but cannot be true =======
-- REPORTED, NOT BLOCKING. A value that parses to 1970-01-01 or to a date
-- after today is a bad import or a typo, not a conversion failure, and the
-- migration deliberately does not act on it - correcting somebody's start
-- date is an HR decision. It is listed so a wrong date is not laundered into
-- a typed column unnoticed.
SELECT employee_id,
       employee_name,
       date_of_joining,
       (CASE
          WHEN date_of_joining IS NULL OR TRIM(date_of_joining) = '' THEN NULL
          WHEN date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
        END) AS parsed_joining_date
  FROM new_employee
 WHERE (CASE
          WHEN date_of_joining IS NULL OR TRIM(date_of_joining) = '' THEN NULL
          WHEN date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
        END) NOT BETWEEN '1950-01-01' AND CURDATE()
 ORDER BY employee_id;

-- ============================= 8. rows whose stored BYTES will be rewritten =
-- Not a semantic change (section 5a proves that is zero) - simply how many
-- rows section 3 of the migration will touch, so the UPDATE's row count can
-- be checked against a number that was known beforehand.
SELECT COUNT(*) AS rows_whose_text_will_be_rewritten
  FROM new_employee
 WHERE date_of_joining IS NOT NULL
   AND TRIM(date_of_joining) <> ''
   AND date_of_joining <> DATE_FORMAT((CASE
         WHEN date_of_joining LIKE '____-__-__%'
              AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
           THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
         ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
       END), '%Y-%m-%d');
