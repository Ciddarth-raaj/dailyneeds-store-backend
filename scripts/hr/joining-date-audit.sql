-- =====================================================================
-- READ-ONLY audit: new_employee.date_of_joining, before it becomes a DATE
--
-- Run this BEFORE the migration below and paste the output into the review.
-- Nothing here writes, locks or deletes - every statement is a SELECT.
--
--   20261012120000-employee-joining-date-to-date
--
-- The migration REFUSES TO RUN if section 5 returns a non-zero count, so this
-- audit is not merely advisory: it is the same predicate the migration
-- enforces, run in advance so the answer is known before a deploy window
-- rather than during one.
--
-- The one parser is `utils/joining_date.js#JOINED_ON`, reproduced verbatim
-- below. It is the expression C1b's backfill ran against production and the
-- expression payroll and the attendance dashboard read today, so auditing
-- with anything else would audit a different question.
-- =====================================================================

-- 0. What the column is now, and the lc_time_names the '%d %M %Y' branch
--    depends on. `%M` returns NULL for "05 September 2021" under any locale
--    but en_US, which would make a perfectly good date look unconvertible.
SELECT VERSION() AS mysql_version, @@lc_time_names AS lc_time_names;

SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'new_employee'
   AND COLUMN_NAME = 'date_of_joining';

-- 1..4. Totals: rows, present, NULL, blank, and unconvertible.
SELECT
  COUNT(*)                                                                AS total_rows,
  SUM(date_of_joining IS NOT NULL AND TRIM(date_of_joining) <> '')        AS non_null_joining_dates,
  SUM(date_of_joining IS NULL)                                            AS null_joining_dates,
  SUM(date_of_joining IS NOT NULL AND TRIM(date_of_joining) = '')         AS blank_joining_dates,
  SUM(
    date_of_joining IS NOT NULL
    AND TRIM(date_of_joining) <> ''
    AND (CASE
           WHEN date_of_joining LIKE '____-__-__%'
                AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
             THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
           ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
         END) IS NULL
  )                                                                       AS unconvertible_values
  FROM new_employee;

-- 5. THE BLOCKING SET. Every row the migration cannot convert, named. This
--    must be EMPTY. If it is not, the migration aborts and these rows are
--    corrected on the Employee Master screen first - never in a migration,
--    because guessing a person's start date is not a schema change.
SELECT employee_id, employee_name, CONCAT('[', date_of_joining, ']') AS raw_value
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

-- 6. THE FORMATS PRESENT, with a count and an example of each. This is the
--    evidence for "the data is now uniform": a single row reading ISO_DATE is
--    what the claim means, and anything else says which other shapes survive.
SELECT
  CASE
    WHEN date_of_joining IS NULL                                THEN 'NULL'
    WHEN TRIM(date_of_joining) = ''                             THEN 'BLANK'
    WHEN date_of_joining REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'  THEN 'ISO_DATE'
    WHEN date_of_joining REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN 'ISO_WITH_TIME'
    WHEN date_of_joining REGEXP '^[0-9]{1,2} [A-Za-z]+ [0-9]{4}$' THEN 'DD_MONTH_YYYY'
    ELSE 'OTHER'
  END                             AS format_shape,
  COUNT(*)                        AS rows_with_this_shape,
  MIN(date_of_joining)            AS example_value
  FROM new_employee
 GROUP BY format_shape
 ORDER BY rows_with_this_shape DESC;

-- 7. Out-of-range dates. A value that PARSES but cannot be true - the epoch
--    zero a bad import writes, or a date after today - is not a conversion
--    failure and the migration does not block on it, but it is reported so a
--    silently wrong date is not laundered into a typed column unnoticed.
SELECT employee_id, employee_name, date_of_joining
  FROM new_employee
 WHERE (CASE
          WHEN date_of_joining IS NULL OR TRIM(date_of_joining) = '' THEN NULL
          WHEN date_of_joining LIKE '____-__-__%'
               AND STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
            THEN STR_TO_DATE(LEFT(date_of_joining, 10), '%Y-%m-%d')
          ELSE STR_TO_DATE(TRIM(date_of_joining), '%d %M %Y')
        END) NOT BETWEEN '1950-01-01' AND CURDATE()
 ORDER BY employee_id;

-- 8. The rows whose stored TEXT is not already the ISO form the migration
--    will leave behind. These are the only rows whose bytes change.
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
