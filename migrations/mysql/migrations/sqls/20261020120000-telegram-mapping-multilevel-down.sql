-- Back to ONE dimension per row.
--
-- THE ONE THING THIS CANNOT DO IS KEEP A MULTI-LEVEL RULE. A row narrowing
-- two or three dimensions has no representation in `mapping_type` +
-- `target_id` - that is the whole reason the up-migration exists. There are
-- only three ways to treat such a row and two of them are worse:
--
--   keep one dimension  -> the rule stays, matching a POPULATION IT NEVER
--                          MATCHED. "Cashiers at Moolakulam" would silently
--                          become "every cashier in the company". Rolling
--                          back would add people to real Telegram groups.
--   split into rows     -> AND becomes OR. Same disclosure, more rows.
--   delete the row      -> the rule is gone, and gone is a state the screen
--                          shows honestly. Nobody is added to anything.
--
-- So multi-level rows are DELETED. They are data created by a feature that
-- only exists above this migration, and on the way down the safe failure is
-- the one that manages nobody rather than the one that manages strangers.
--
-- EVERY SINGLE-DIMENSION ROW ROUND-TRIPS EXACTLY, including the all-zero rule
-- that becomes ALL_EMPLOYEES again. A database that went up and came back
-- down without the new screen ever being used is byte-for-byte what it was.

DELETE FROM `telegram_group_mapping`
 WHERE (`rule_outlet_id` <> 0) + (`rule_department_id` <> 0) + (`rule_designation_id` <> 0) > 1;

ALTER TABLE `telegram_group_mapping`
  ADD COLUMN `mapping_type` ENUM('ALL_EMPLOYEES','OUTLET','DESIGNATION','DEPARTMENT')
    NOT NULL DEFAULT 'ALL_EMPLOYEES' AFTER `telegram_group_id`,
  ADD COLUMN `target_id` INT NOT NULL DEFAULT 0 AFTER `mapping_type`;

UPDATE `telegram_group_mapping`
   SET `mapping_type` = CASE
         WHEN `rule_outlet_id`      <> 0 THEN 'OUTLET'
         WHEN `rule_department_id`  <> 0 THEN 'DEPARTMENT'
         WHEN `rule_designation_id` <> 0 THEN 'DESIGNATION'
         ELSE 'ALL_EMPLOYEES' END,
       -- Exactly one is non-zero here, the DELETE above having removed the
       -- rows where that was not true, so the largest IS the narrowed one.
       `target_id` = GREATEST(`rule_outlet_id`, `rule_department_id`, `rule_designation_id`);

ALTER TABLE `telegram_group_mapping`
  ALTER COLUMN `mapping_type` DROP DEFAULT,
  ALTER COLUMN `target_id` DROP DEFAULT,
  DROP INDEX `uq_tgm_group_rule`,
  ADD UNIQUE KEY `uq_tgm_group_type_target` (`telegram_group_id`, `mapping_type`, `target_id`),
  DROP COLUMN `rule_outlet_id`,
  DROP COLUMN `rule_department_id`,
  DROP COLUMN `rule_designation_id`;
