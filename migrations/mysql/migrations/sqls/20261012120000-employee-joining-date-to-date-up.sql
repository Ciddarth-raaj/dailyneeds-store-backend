-- `new_employee.date_of_joining`: VARCHAR(45) -> DATE.
--
-- WHAT IS WRONG WITH A TEXT DATE. Every comparison against it is a string
-- comparison unless something casts it first, and the codebase is full of the
-- consequences: `MONTH(date_of_joining)` silently returns NULL for the Indian
-- long form, the bulk recalculation applied its joining bound in JS "because
-- date_of_joining is text", the attendance dashboard wraps every read in a
-- CASE expression, and the Employee Master's edit form cannot bind a value it
-- cannot recognise as a date. One typed column removes all of that at the
-- source instead of adding a cast at each of ten call sites.
--
-- WHAT THIS MIGRATION DOES, IN ORDER:
--
--   1. reports the audit (the same figures scripts/hr/joining-date-audit.sql
--      produces, so a deploy log carries its own evidence);
--   2. ABORTS if any present value cannot be read by the one shared parser;
--   3. normalises blanks to NULL and every readable value to its ISO text;
--   4. alters the column to DATE NULL.
--
-- NO DATE IS ALTERED. Step 3 rewrites the REPRESENTATION of a date, never the
-- date: "05 September 2021" becomes "2021-09-05" and "2022-04-01 00:00:00"
-- becomes "2022-04-01". A row whose value the parser cannot read is not
-- guessed at, defaulted, or dropped - it stops the migration at step 2, and
-- is corrected by a human on the Employee Master screen first. Guessing
-- somebody's start date is not a schema change.
--
-- THE PARSER IS `utils/joining_date.js#JOINED_ON`, reproduced verbatim. It is
-- the expression C1b's backfill ran against production and the one payroll
-- and the attendance dashboard read today. Using a second parser here would
-- migrate the column to dates that disagree with the periods already derived
-- from it. `%M` and not `%b`, and it needs `lc_time_names = 'en_US'` - which
-- step 2 asserts rather than assumes, because under another locale every long
-- form row would look unconvertible and abort a migration that is fine.
--
-- IT SURVIVES THE CHANGE. `JOINED_ON` applied to a DATE column still yields
-- that date - `TRIM(d)` renders it as 'YYYY-MM-DD', which the ISO branch
-- reads - so nothing that reads through the shared parser has to change on
-- the day this runs, in either order. That is deliberate: the schema change
-- and the code change are independently deployable.
--
-- Guarded on information_schema so the whole file can be re-run.

-- ========================================================== 1. the audit ===
-- REPORT ONLY. db-migrate prints result sets.
SELECT
  COUNT(*)                                                         AS total_rows,
  SUM(`date_of_joining` IS NOT NULL AND TRIM(`date_of_joining`) <> '') AS non_null_joining_dates,
  SUM(`date_of_joining` IS NULL)                                   AS null_joining_dates,
  SUM(`date_of_joining` IS NOT NULL AND TRIM(`date_of_joining`) = '') AS blank_joining_dates,
  SUM(
    `date_of_joining` IS NOT NULL AND TRIM(`date_of_joining`) <> ''
    AND (CASE
           WHEN `date_of_joining` LIKE '____-__-__%'
                AND STR_TO_DATE(LEFT(`date_of_joining`, 10), '%Y-%m-%d') IS NOT NULL
             THEN STR_TO_DATE(LEFT(`date_of_joining`, 10), '%Y-%m-%d')
           ELSE STR_TO_DATE(TRIM(`date_of_joining`), '%d %M %Y')
         END) IS NULL
  )                                                                AS unconvertible_values
  FROM `new_employee`;

-- ====================================================== 2. the two guards ===
-- The locale the '%d %M %Y' branch depends on. Asserted before the count
-- below, because a wrong locale would make that count lie.
SET @locale_ok = IF(@@lc_time_names = 'en_US', 'DO 0',
  'SELECT 1 FROM `new_employee` WHERE `__ABORT_lc_time_names_must_be_en_US_for_the_joining_date_parser__` = 1');
PREPARE stmt FROM @locale_ok;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- THE HARD STOP. If any present value cannot be parsed, this statement
-- references a column that does not exist and the migration fails with that
-- column name as the message. A deliberately ugly mechanism: db-migrate runs
-- a plain SQL file with no procedural block available, and failing loudly
-- with a readable reason beats converting 583 rows correctly and one row to
-- NULL. Run scripts/hr/joining-date-audit.sql section 5 to list the rows.
SET @data_ok = IF(
  (SELECT COUNT(*) FROM `new_employee`
    WHERE `date_of_joining` IS NOT NULL
      AND TRIM(`date_of_joining`) <> ''
      AND (CASE
             WHEN `date_of_joining` LIKE '____-__-__%'
                  AND STR_TO_DATE(LEFT(`date_of_joining`, 10), '%Y-%m-%d') IS NOT NULL
               THEN STR_TO_DATE(LEFT(`date_of_joining`, 10), '%Y-%m-%d')
             ELSE STR_TO_DATE(TRIM(`date_of_joining`), '%d %M %Y')
           END) IS NULL) = 0,
  'DO 0',
  'SELECT 1 FROM `new_employee` WHERE `__ABORT_unconvertible_date_of_joining_values_exist_fix_them_on_Employee_Master_first__` = 1');
PREPARE stmt FROM @data_ok;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =================================================== 3. normalise the text ===
-- Only meaningful while the column is still text, so both statements are
-- skipped on a re-run after the ALTER has already happened.
SET @is_text = (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                 WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                   AND `COLUMN_NAME` = 'date_of_joining' AND `DATA_TYPE` <> 'date');

-- A blank string is not a date and never was one; it is the absence of a
-- value, and NULL is how this schema spells that.
SET @blank_to_null = IF(@is_text > 0,
  'UPDATE `new_employee` SET `date_of_joining` = NULL WHERE `date_of_joining` IS NOT NULL AND TRIM(`date_of_joining`) = ''''',
  'DO 0');
PREPARE stmt FROM @blank_to_null;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Every readable value to its own date, written as ISO text. Guarded by
-- `<>` so a row already in that shape is not rewritten and `updated_at` -
-- if the table ever gains ON UPDATE - does not move for 584 people.
SET @normalise = IF(@is_text > 0,
  'UPDATE `new_employee`
      SET `date_of_joining` = DATE_FORMAT((CASE
            WHEN `date_of_joining` LIKE ''____-__-__%''
                 AND STR_TO_DATE(LEFT(`date_of_joining`, 10), ''%Y-%m-%d'') IS NOT NULL
              THEN STR_TO_DATE(LEFT(`date_of_joining`, 10), ''%Y-%m-%d'')
            ELSE STR_TO_DATE(TRIM(`date_of_joining`), ''%d %M %Y'')
          END), ''%Y-%m-%d'')
    WHERE `date_of_joining` IS NOT NULL
      AND `date_of_joining` <> DATE_FORMAT((CASE
            WHEN `date_of_joining` LIKE ''____-__-__%''
                 AND STR_TO_DATE(LEFT(`date_of_joining`, 10), ''%Y-%m-%d'') IS NOT NULL
              THEN STR_TO_DATE(LEFT(`date_of_joining`, 10), ''%Y-%m-%d'')
            ELSE STR_TO_DATE(TRIM(`date_of_joining`), ''%d %M %Y'')
          END), ''%Y-%m-%d'')',
  'DO 0');
PREPARE stmt FROM @normalise;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =============================== 3b. the LAST LINE OF DEFENCE ==============
-- Assert, AFTER normalising and IMMEDIATELY BEFORE the ALTER, that every
-- remaining non-NULL value is exactly `YYYY-MM-DD`.
--
-- Defence in depth rather than a known defect: the guard in section 2 already
-- refuses to proceed on an unreadable value, and section 3 rewrites the rest.
-- But the two are separated by two UPDATEs, and it is the ALTER that is
-- dangerous - under a non-strict `sql_mode` MySQL would coerce anything it
-- could not read to `0000-00-00` or NULL SILENTLY, turning a row nobody
-- looked at into a wrong date nobody can recover. A row inserted between the
-- guard and the ALTER by a concurrent writer is the realistic way that
-- happens. Checking the shape one statement before the conversion costs a
-- scan of 584 rows and removes the possibility entirely.
--
-- The shape test is deliberately TEXTUAL (`LIKE '____-__-__'`) rather than a
-- second date parse: at this point every value has already been produced by
-- DATE_FORMAT, so what is being confirmed is that section 3 actually ran and
-- covered every row.
SET @normalised_ok = IF(
  (SELECT COUNT(*) FROM `new_employee`
    WHERE `date_of_joining` IS NOT NULL
      AND `date_of_joining` NOT LIKE '____-__-__') = 0,
  'DO 0',
  'SELECT 1 FROM `new_employee` WHERE `__ABORT_a_date_of_joining_value_is_still_not_YYYY_MM_DD_after_normalising__` = 1');
PREPARE stmt FROM @normalised_ok;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ======================================================= 4. the ALTER ======
-- NULL stays permitted: 425 of the production rows have no joining date at
-- all, and a NOT NULL column would have to invent one for each of them.
-- No DEFAULT, for the same reason.
SET @alter = IF(@is_text > 0,
  'ALTER TABLE `new_employee` MODIFY COLUMN `date_of_joining` DATE NULL DEFAULT NULL COMMENT ''the current spell''''s joining date. Owned by create / rejoin / the joining-date correction''',
  'DO 0');
PREPARE stmt FROM @alter;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ======================================================== 5. the proof =====
-- REPORT ONLY. The column's new type, and the same counts again.
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM `information_schema`.`COLUMNS`
 WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
   AND `COLUMN_NAME` = 'date_of_joining';

SELECT COUNT(*) AS total_rows,
       SUM(`date_of_joining` IS NOT NULL) AS non_null_joining_dates,
       SUM(`date_of_joining` IS NULL)     AS null_joining_dates,
       MIN(`date_of_joining`)             AS earliest_joining_date,
       MAX(`date_of_joining`)             AS latest_joining_date
  FROM `new_employee`;
