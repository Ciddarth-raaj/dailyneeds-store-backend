-- Telegram Group Mapping - WHICH EMPLOYEES SHOULD BELONG TO WHICH GROUP.
--
-- ADDITIVE ONLY. One new table. No existing table, column, row, permission or
-- grant is touched, and no new permission key is created: this screen is
-- governed by the registry's own `view_telegram_groups` and
-- `manage_telegram_groups`, because a mapping is part of the group it belongs
-- to rather than a subsystem of its own.
--
-- THIS TABLE STORES INTENT, NEVER MEMBERSHIP. Nothing here records who IS in
-- a Telegram group; it records who SHOULD be. No row in this table causes
-- anybody to be added, removed, invited or banned - that is the next phase.
-- A mapping is configuration, which is why it is safe to get wrong and easy
-- to undo.
--
-- FOUR MAPPING TYPES AND NO RULE ENGINE. ALL_EMPLOYEES, OUTLET, DESIGNATION,
-- DEPARTMENT. The union of a group's mappings, deduplicated by employee, is
-- its population. Deliberately not a stored query, a predicate string or a
-- list of hand-picked employees: each of those is a thing somebody must read
-- and re-verify before trusting, and the point of this table is that a row
-- can be understood at a glance.
--
-- `target_id` IS NOT NULL, AND ALL_EMPLOYEES STORES 0. That is the whole
-- reason for the sentinel. MySQL treats NULLs as distinct in a UNIQUE index,
-- so a nullable target would let "All Employees" be added to one group ten
-- times over and the index would raise no objection. Zero is not an id in
-- `outlets`, `designation` or `department` - those are AUTO_INCREMENT and
-- start at 1 - so it cannot collide with a real target either.
--
-- THE UNIQUE KEY IS THE RULE, NOT THE PRE-CHECK. The usecase looks for an
-- existing mapping first so the user reads a sentence rather than a driver
-- error, but two requests can pass that check in the same instant and only
-- this index decides.
--
-- `target_id` CARRIES NO FOREIGN KEY, DELIBERATELY. It points at three
-- different master tables depending on `mapping_type`, and at nothing at all
-- when the type is ALL_EMPLOYEES, so there is no one table to point it at. A
-- FK to any single master would be wrong for the other three cases.
--
-- MORE IMPORTANTLY, A MISSING TARGET MUST SURVIVE. If this column cascaded
-- from `outlets`, deleting an outlet would silently delete the mapping that
-- named it, and the configuration would be gone with nothing to say it ever
-- existed - the screen would show a group with fewer rules than its owner
-- left there. Instead the row stays, the usecase resolves the target on read,
-- and a target that is inactive or has vanished is SHOWN WITH A WARNING. A
-- valid rule matching nobody and a rule whose target no longer exists are
-- different states and must look different.
--
-- THE GROUP FK DOES CASCADE, because the opposite is true there: a mapping
-- has no meaning without the group it maps into, and leaving orphans behind
-- after a group is deleted would let a future group reusing the id inherit
-- somebody else's rules.

CREATE TABLE IF NOT EXISTS `telegram_group_mapping` (
  `telegram_group_mapping_id` INT NOT NULL AUTO_INCREMENT,
  `telegram_group_id` INT NOT NULL,
  `mapping_type` ENUM('ALL_EMPLOYEES','OUTLET','DESIGNATION','DEPARTMENT') NOT NULL
    COMMENT 'fixed list - constants/telegram_group_mapping.js. No rule engine, no hand-picked employees',
  `target_id` INT NOT NULL
    COMMENT '0 for ALL_EMPLOYEES. Otherwise outlets.outlet_id, designation.designation_id or department.department_id by type. Deliberately no FK - see the header',
  `created_by` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`telegram_group_mapping_id`),
  UNIQUE KEY `uq_tgm_group_type_target` (`telegram_group_id`, `mapping_type`, `target_id`),
  KEY `idx_tgm_group` (`telegram_group_id`),
  CONSTRAINT `fk_tgm_group` FOREIGN KEY (`telegram_group_id`)
    REFERENCES `telegram_group_registry` (`telegram_group_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
