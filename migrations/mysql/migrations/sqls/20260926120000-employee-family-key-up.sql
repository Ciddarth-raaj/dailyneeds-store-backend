-- employee_family: key the records on employee_id, not employee_name.
--
-- WHAT IS WRONG TODAY. `employee_family.employee_name` VARCHAR(45) is the
-- only link from a family record to the employee it belongs to
-- (repository/family.js#getFamilyByEmployee selects on it). Two consequences,
-- both live:
--
--   a name correction on `new_employee` orphans every family record of that
--   employee - the rows stay, attached to a name nobody has any more;
--
--   two employees sharing a name share their family records, and the schema
--   cannot tell them apart. The business has several such pairs.
--
-- WHAT THIS MIGRATION DOES. Additively, and without changing any behaviour:
--
--   1. adds `employee_id INT NULL` to `employee_family`, indexed, with a
--      foreign key to `new_employee`;
--   2. backfills it ONLY where the name resolves to EXACTLY ONE employee;
--   3. reports every row it could not resolve, and why.
--
-- `employee_name` IS KEPT, unchanged and still written. Nothing reads
-- `employee_id` yet, so this migration cannot break a screen: the two columns
-- simply agree. That is deliberate - the column has to exist and be correct
-- before the application can be cut over to it.
--
-- WHAT IT DOES NOT DO, ON PURPOSE.
--
--   It does not guess. A family record whose name matches several employees,
--   or none, keeps employee_id NULL and appears in the report below for HR to
--   attach by hand. Picking the lowest id would silently give one employee
--   another employee's family.
--
--   It does not make employee_id NOT NULL. It cannot, while unresolved rows
--   exist, and forcing it would mean deleting them.
--
--   It does not touch repository/family.js, the routes or the UI. The cutover
--   is a separate, reviewable change: read by employee_id, write employee_id
--   on create, keep employee_name in sync for one release, then stop writing
--   it and finally drop it. Each step is safe on its own; this migration is
--   the precondition for the first.
--
-- Run scripts/hr/employee-identity-audit.sql (sections 8-11) first for the
-- counts. This file is guarded on information_schema and re-runnable; the
-- backfill only ever fills NULLs, so re-running never overwrites a manual
-- correction.

-- -------------------------------------------------------- 1. the column
SET @add_employee_id = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_family'
      AND `COLUMN_NAME` = 'employee_id') = 0,
  'ALTER TABLE `employee_family` ADD COLUMN `employee_id` INT NULL DEFAULT NULL COMMENT ''new_employee.employee_id - the permanent link. NULL = not resolvable from employee_name'' AFTER `family_id`',
  'DO 0');
PREPARE stmt FROM @add_employee_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_index = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_family'
      AND `INDEX_NAME` = 'idx_employee_family_employee') = 0,
  'ALTER TABLE `employee_family` ADD INDEX `idx_employee_family_employee` (`employee_id`)',
  'DO 0');
PREPARE stmt FROM @add_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------- 2. the backfill
-- Exactly one matching employee, or nothing. The correlated count is the
-- whole guard: a name held by two employees resolves to neither.
--
-- Written before the foreign key is added, so an unexpected non-match cannot
-- half-apply: every value this writes is an existing employee_id by
-- construction, and the key below then proves it.
UPDATE `employee_family` f
   JOIN `new_employee` ne ON ne.`employee_name` = f.`employee_name`
    SET f.`employee_id` = ne.`employee_id`
  WHERE f.`employee_id` IS NULL
    AND (SELECT COUNT(*) FROM `new_employee` x
          WHERE x.`employee_name` = f.`employee_name`) = 1;

-- ---------------------------------------------------- 3. the foreign key
-- Added after the backfill, and only if every filled value resolves - which
-- the backfill guarantees, and this re-checks rather than assumes, so a
-- database carrying hand-written values is not silently rejected by the
-- ALTER. NULL rows are permitted by the key and stay unattached.
SET @fk_safe = (SELECT COUNT(*) FROM `employee_family` f
                 WHERE f.`employee_id` IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM `new_employee` ne
                                    WHERE ne.`employee_id` = f.`employee_id`));
SET @add_fk = IF(
  @fk_safe = 0 AND
  (SELECT COUNT(*) FROM `information_schema`.`TABLE_CONSTRAINTS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_family'
      AND `CONSTRAINT_NAME` = 'fk_employee_family_employee') = 0,
  'ALTER TABLE `employee_family` ADD CONSTRAINT `fk_employee_family_employee` FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)',
  'DO 0');
PREPARE stmt FROM @add_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =========================================================== 4. report ====
-- REPORT ONLY. db-migrate prints these, so the deploy shows exactly what is
-- attached and what still needs a person.
SELECT COUNT(*) AS family_rows,
       SUM(`employee_id` IS NOT NULL) AS ATTACHED_to_an_employee_id,
       SUM(`employee_id` IS NULL) AS STILL_BY_NAME_ONLY
  FROM `employee_family`;

-- Ambiguous: the name belongs to more than one employee. HR must say which.
SELECT f.`family_id`, f.`employee_name`, f.`name` AS family_member, f.`relation`,
       (SELECT GROUP_CONCAT(x.`employee_id` ORDER BY x.`employee_id`) FROM `new_employee` x
         WHERE x.`employee_name` = f.`employee_name`) AS AMBIGUOUS_candidate_employee_ids
  FROM `employee_family` f
 WHERE f.`employee_id` IS NULL
   AND (SELECT COUNT(*) FROM `new_employee` x WHERE x.`employee_name` = f.`employee_name`) > 1
 ORDER BY f.`employee_name`, f.`family_id`;

-- Orphaned: no employee holds that name at all, most likely a name
-- correction after the record was created. This is the failure the column
-- above prevents in future.
SELECT f.`family_id`, f.`employee_name` AS ORPHANED_no_employee_holds_this_name,
       f.`name` AS family_member, f.`relation`
  FROM `employee_family` f
 WHERE f.`employee_id` IS NULL
   AND NOT EXISTS (SELECT 1 FROM `new_employee` ne WHERE ne.`employee_name` = f.`employee_name`)
 ORDER BY f.`employee_name`, f.`family_id`;
