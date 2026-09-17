-- MULTI-LEVEL MAPPING RULES - Outlet AND Department AND Designation.
--
-- WHAT CHANGES. `telegram_group_mapping` stops holding ONE dimension per row
-- (`mapping_type` + `target_id`) and starts holding THREE optional ones. A
-- rule is now the conjunction of whichever dimensions it narrows:
--
--   rule_outlet_id=3, rule_department_id=0, rule_designation_id=7
--     -> designation 7, at outlet 3, in any department
--
-- NO RULE DISAPPEARS, AND NONE CHANGES MEANING. Every legacy row maps onto
-- exactly one composite row:
--
--   ALL_EMPLOYEES -> (0, 0, 0)   nothing narrowed, which IS everybody
--   OUTLET,      n -> (n, 0, 0)
--   DEPARTMENT,  n -> (0, n, 0)
--   DESIGNATION, n -> (0, 0, n)
--
-- AND NO TWO LEGACY ROWS CAN COLLIDE ON THE WAY. The old UNIQUE key made
-- (group, type, target) unique, and distinct (type, target) pairs land on
-- distinct triples - a department id and an outlet id that happen to share
-- the number 5 become (0,5,0) and (5,0,0). So the new UNIQUE key below can be
-- added directly, with no de-duplication step and nothing dropped. A backfill
-- that silently merged two rules would be the one failure mode that matters
-- here, and the old index already rules it out.
--
-- 0 MEANS UNRESTRICTED, AND IT IS NOT NULL FOR THE REASON THE ORIGINAL
-- SENTINEL EXISTED. MySQL treats NULLs as DISTINCT in a UNIQUE index, so
-- three nullable dimensions would let the SAME rule be added to one group any
-- number of times with the index raising no objection - and the duplicates
-- would each be counted and each be separately deletable. `outlets`,
-- `designation` and `department` are AUTO_INCREMENT from 1, so 0 collides
-- with no real target.
--
-- THE OLD COLUMNS ARE DROPPED RATHER THAN KEPT IN STEP. Keeping
-- `mapping_type` beside the composite columns would be two records of one
-- fact, and the day they disagreed the one deciding who is in a real
-- Telegram group would be whichever the reader happened to pick. The single
-- decoder in `utils/telegram_group_mapping.js#ruleOf` still understands the
-- legacy shape, so request bodies and older fixtures keep working - but
-- STORAGE has exactly one truth.
--
-- NO FOREIGN KEYS ON THE THREE DIMENSIONS, for the reason the original
-- `target_id` had none: a mapping whose outlet was deleted must SURVIVE and
-- be shown with a warning, not vanish along with the decision somebody made.

ALTER TABLE `telegram_group_mapping`
  ADD COLUMN `rule_outlet_id` INT NOT NULL DEFAULT 0
    COMMENT '0 = any outlet. Otherwise outlets.outlet_id. No FK - a deleted target must not delete the rule'
    AFTER `telegram_group_id`,
  ADD COLUMN `rule_department_id` INT NOT NULL DEFAULT 0
    COMMENT '0 = any department. Otherwise department.department_id'
    AFTER `rule_outlet_id`,
  ADD COLUMN `rule_designation_id` INT NOT NULL DEFAULT 0
    COMMENT '0 = any designation. Otherwise designation.designation_id'
    AFTER `rule_department_id`;

UPDATE `telegram_group_mapping`
   SET `rule_outlet_id`      = IF(`mapping_type` = 'OUTLET',      `target_id`, 0),
       `rule_department_id`  = IF(`mapping_type` = 'DEPARTMENT',  `target_id`, 0),
       `rule_designation_id` = IF(`mapping_type` = 'DESIGNATION', `target_id`, 0);

ALTER TABLE `telegram_group_mapping`
  DROP INDEX `uq_tgm_group_type_target`,
  ADD UNIQUE KEY `uq_tgm_group_rule`
    (`telegram_group_id`, `rule_outlet_id`, `rule_department_id`, `rule_designation_id`),
  DROP COLUMN `mapping_type`,
  DROP COLUMN `target_id`;
