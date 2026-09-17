-- Reverses the expand migration exactly: the three columns, the index and the
-- extra ENUM value. The legacy columns were never dropped, so there is
-- nothing to restore.
--
-- MULTI-LEVEL ROWS ARE DELETED, because below this migration they cannot
-- exist: `mapping_type` loses 'COMPOSITE', and the three ways to treat such a
-- row are not equal -
--
--   keep one dimension  -> the rule stays, matching a POPULATION IT NEVER
--                          MATCHED. "Cashiers at Moolakulam" would silently
--                          become "every cashier in the company", and rolling
--                          back would ADD people to real Telegram groups.
--   split into rows     -> AND becomes OR. Same disclosure, more rows.
--   delete the row      -> the rule is gone, and gone is a state the screen
--                          shows honestly. Nobody is added to anything.
--
-- Every single-dimension row round-trips untouched: its legacy columns were
-- never modified on the way up, so there is nothing to rebuild. A database
-- that went up and came back down without the new screen ever being used is
-- byte-for-byte what it was.

DELETE FROM `telegram_group_mapping` WHERE `mapping_type` = 'COMPOSITE';

ALTER TABLE `telegram_group_mapping`
  DROP INDEX `uq_tgm_group_rule`,
  DROP COLUMN `rule_outlet_id`,
  DROP COLUMN `rule_department_id`,
  DROP COLUMN `rule_designation_id`,
  MODIFY COLUMN `mapping_type`
    ENUM('ALL_EMPLOYEES','OUTLET','DESIGNATION','DEPARTMENT') NOT NULL
    COMMENT 'fixed list - constants/telegram_group_mapping.js. No rule engine, no hand-picked employees';
