-- Employee identity: an index on the name, and a key a sync cannot bypass.
--
-- WHAT WENT WRONG. `new_employee` has no key beyond its AUTO_INCREMENT
-- primary key, so nothing in the database has ever had an opinion about who
-- an employee IS. When the Digisme sync ran without supplying a usable
-- `employee_id`, every night's insert was a new person as far as InnoDB was
-- concerned, and 54 identical "Amit P" rows accumulated over 54 nights with
-- nothing to stop it. `employee_name` is also unindexed, so the queries that
-- would have found this - and the `employee_family` join, which keys on the
-- name - are full scans.
--
-- WHAT THIS MIGRATION DOES, AND DOES NOT DO.
--
--   It adds an INDEX on `employee_name` (non-unique).
--   It adds two nullable source-identity columns and a UNIQUE key over them.
--   It reports duplicate rows that already exist.
--
-- It does NOT add a unique key over `employee_name`, and it must not: the
-- business has several genuine namesakes, so such a key would be wrong even
-- if the duplicates were merged first. It does not merge, delete, renumber
-- or edit a single employee row - merging duplicate people is an HR decision
-- about real records and belongs on a screen with an audit trail, not in a
-- migration. And because both new columns start NULL and InnoDB allows many
-- NULLs in a unique index, NOTHING HERE CAN FAIL ON EXISTING DATA however
-- many duplicates the audit finds.
--
-- Run scripts/hr/employee-identity-audit.sql first; sections 3-7 are the
-- violation report this migration deliberately does not act on.
--
-- WHY A SOURCE IDENTIFIER RATHER THAN A NAME. The only honest unique key for
-- a person is an identifier issued by whoever owns the record. Inside
-- dnds.co.in that is `employee_id` itself, and it is already unique. The gap
-- is the OTHER direction: a row arriving from outside - the Digisme sync, a
-- spreadsheet import, whatever replaces them - carries its own identifier for
-- the same person and had nowhere to put it, so the database could not tell
-- the second delivery of one employee from a second employee. That is the
-- key added here:
--
--   source_system         who the row came from, e.g. 'DIGISME', 'XLSX_IMPORT'
--   source_employee_code  their identifier for this person, verbatim
--   UNIQUE (source_system, source_employee_code)
--
-- An importer that fills these two columns gets the guard for free: the 55th
-- insert of the same source row is rejected by the database, whatever the
-- application layer believes. An employee created locally by HR leaves both
-- NULL and is unaffected - which is every employee created from now on, since
-- the Digisme employee sync is switched off.
--
-- A CONSTRAINT ONLY BINDS THE WRITER THAT FILLS IT. Adding these columns
-- does not retroactively protect anything: the historical rows have no source
-- code, and no current writer sets one. It is a precondition for the next
-- importer, not a fix for the last one. The immediate protection against a
-- repeat is that the sync that caused it is disabled at two independent
-- switches (config/lifecycle.js) and is scheduled for removal.
--
-- Deliberately NOT backfilled from `employee_id`. The Digisme-era rows took
-- their id from EmployeeCode, so a backfill would write one distinct code per
-- row and pass the unique check while telling us nothing - the 54 duplicates
-- have 54 distinct ids. A code is worth writing only by a writer that knows
-- which source row it came from.
--
-- Guarded on information_schema so the whole file can be re-run.

-- ------------------------------------------------- 1. index the name
-- Non-unique. This is what makes the duplicate-detection queries, the
-- directory search and the employee_family name join stop scanning 305 rows
-- (and every row of every future year) to find one person.
SET @add_name_index = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `INDEX_NAME` = 'idx_new_employee_name') = 0,
  'ALTER TABLE `new_employee` ADD INDEX `idx_new_employee_name` (`employee_name`)',
  'DO 0');
PREPARE stmt FROM @add_name_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- --------------------------------------- 2. the source identity columns
SET @add_source_system = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'source_system') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `source_system` VARCHAR(20) NULL DEFAULT NULL COMMENT ''the system this row was delivered by, e.g. DIGISME. NULL = created here''',
  'DO 0');
PREPARE stmt FROM @add_source_system;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_source_code = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'source_employee_code') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `source_employee_code` VARCHAR(32) NULL DEFAULT NULL COMMENT ''that system''''s identifier for this person, verbatim. NULL = created here''',
  'DO 0');
PREPARE stmt FROM @add_source_code;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------ 3. the unique key
-- Both columns are NULL on every existing row, and InnoDB treats each NULL
-- as distinct, so this cannot reject anything currently stored. It binds
-- only rows that name their source.
SET @add_source_key = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `INDEX_NAME` = 'uq_new_employee_source') = 0,
  'ALTER TABLE `new_employee` ADD UNIQUE KEY `uq_new_employee_source` (`source_system`, `source_employee_code`)',
  'DO 0');
PREPARE stmt FROM @add_source_key;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =========================================================== 4. report ====
-- REPORT ONLY. db-migrate prints result sets, so whoever runs the deploy
-- sees the duplicates that remain. Nothing above acted on them.
SELECT employee_name,
       COUNT(*) AS DUPLICATE_EMPLOYEE_ROWS_merge_on_the_HR_screen,
       MIN(employee_id) AS first_employee_id,
       MAX(employee_id) AS last_employee_id,
       COUNT(DISTINCT DATE(created_at)) AS distinct_create_days
  FROM `new_employee`
 GROUP BY employee_name
HAVING COUNT(*) > 1
 ORDER BY COUNT(*) DESC, employee_name;
