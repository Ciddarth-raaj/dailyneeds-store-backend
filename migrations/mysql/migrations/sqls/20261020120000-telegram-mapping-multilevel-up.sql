-- MULTI-LEVEL MAPPING RULES - Outlet AND Department AND Designation.
--
-- ============================ THIS MIGRATION IS EXPAND-ONLY =================
--
-- IT DROPS NOTHING. `mapping_type`, `target_id` and `uq_tgm_group_type_target`
-- all stay exactly where they are, and that is the whole point of this file.
--
-- The deploy sequence is `git pull -> npm install -> db-migrate up -> pm2
-- reload`, so THE OLD NODE PROCESS IS STILL SERVING REQUESTS WHILE THIS RUNS.
-- Every query it makes names `mapping_type` and `target_id` - the employee
-- Telegram panel, the join-request approval, the status summary and the Map
-- screen all read them. Dropping either column here would take those down
-- with a missing-column error for the whole window between this migration and
-- the reload, which is an outage, not a deployment.
--
-- Removing the legacy columns is a CONTRACT migration and belongs in a
-- separate, later change - after this version has run in production long
-- enough to prove nothing still reads them.
--
-- ==================== THE NEW COLUMNS ARE NULLABLE, AND MUST BE =============
--
-- NULL means "this row has no composite rule yet - read the legacy columns".
--
-- THE OLD PROCESS CAN STILL WRITE A MAPPING before the reload, and its INSERT
-- names only (telegram_group_id, mapping_type, target_id, created_by). Had
-- these columns been NOT NULL DEFAULT 0, that insert would silently land on
-- (0, 0, 0) - which the new code reads as "every dimension unrestricted",
-- i.e. ALL EMPLOYEES. An operator adding a single-outlet rule during the
-- window would have created a company-wide one, and nothing would have said
-- so. Nullable columns make that row say "I am legacy, decode me from
-- mapping_type", which is the truth.
--
-- It also keeps the new UNIQUE key honest about those rows: MySQL treats
-- NULLs as DISTINCT, so old-code rows neither collide with each other nor
-- with anything the new code writes. They stay guarded by
-- `uq_tgm_group_type_target`, which is still there.
--
-- ======================= 0 MEANS UNRESTRICTED, ON A MIGRATED ROW ============
--
-- Within a row the new code has written, 0 is the "no restriction" sentinel
-- and NOT NULL - the same sentinel and the same reason ALL_EMPLOYEES' target
-- had. A nullable-per-dimension design would let the same rule be added to
-- one group any number of times with the UNIQUE index raising no objection.
-- So: all three NULL = legacy row; any of them non-NULL = composite row where
-- 0 reads as "any".
--
-- ============================= WHY 'COMPOSITE' JOINS THE ENUM ===============
--
-- A rule narrowing two or three dimensions HAS NO LEGACY REPRESENTATION. The
-- old columns can express one dimension, and there is no honest way to write
-- "Cashiers at Moolakulam" as one of them:
--
--   OUTLET, Moolakulam   would BROADEN it to everybody at that outlet
--   DESIGNATION, Cashier would BROADEN it to every cashier in the company
--
-- Either would have the old process, still live, telling real people to join
-- a group they do not belong in. So the legacy pair is written NEUTRAL
-- instead: `mapping_type = 'COMPOSITE'`, which the old matcher does not
-- recognise -
--
--     const column = DIMENSION_COLUMN[mapping.mapping_type];
--     if (!column) return false;
--
-- - so it matches NOBODY there. The old process sees a row it cannot act on
-- rather than a rule it would act on wrongly. Under-reaching for a few
-- minutes is recoverable; over-reaching is somebody removed from, or added
-- to, a group they should not have been.
--
-- 'COMPOSITE' is APPENDED to the ENUM rather than inserted, so MySQL treats
-- it as metadata-only and no row is rewritten.
--
-- `target_id` on such a row is set to the row's own id by the usecase, purely
-- so `uq_tgm_group_type_target` stays satisfiable when one group carries
-- several multi-level rules. It is never read as a target by anybody.
--
-- =========================== NO RULE DISAPPEARS IN THE BACKFILL =============
--
--   ALL_EMPLOYEES -> (0, 0, 0)   nothing narrowed, which IS everybody
--   OUTLET,      n -> (n, 0, 0)
--   DEPARTMENT,  n -> (0, n, 0)
--   DESIGNATION, n -> (0, 0, n)
--
-- Distinct (type, target) pairs land on distinct triples - a department id
-- and an outlet id that both happen to be 5 become (0,5,0) and (5,0,0) - and
-- the old UNIQUE key already made those pairs unique. So the new index can be
-- added with no de-duplication step and nothing dropped. A backfill that
-- silently merged two rules is the one failure that matters here, and the old
-- index rules it out.
--
-- NO FOREIGN KEYS ON THE THREE DIMENSIONS, for the reason `target_id` has
-- none: a mapping whose outlet was deleted must SURVIVE and be shown with a
-- warning, not vanish along with the decision somebody made.

ALTER TABLE `telegram_group_mapping`
  ADD COLUMN `rule_outlet_id` INT NULL DEFAULT NULL
    COMMENT 'NULL = legacy row, read mapping_type. 0 = any outlet. No FK - a deleted target must not delete the rule'
    AFTER `target_id`,
  ADD COLUMN `rule_department_id` INT NULL DEFAULT NULL
    COMMENT 'NULL = legacy row. 0 = any department'
    AFTER `rule_outlet_id`,
  ADD COLUMN `rule_designation_id` INT NULL DEFAULT NULL
    COMMENT 'NULL = legacy row. 0 = any designation'
    AFTER `rule_department_id`;

UPDATE `telegram_group_mapping`
   SET `rule_outlet_id`      = IF(`mapping_type` = 'OUTLET',      `target_id`, 0),
       `rule_department_id`  = IF(`mapping_type` = 'DEPARTMENT',  `target_id`, 0),
       `rule_designation_id` = IF(`mapping_type` = 'DESIGNATION', `target_id`, 0);

-- APPENDED, so this is a metadata-only change and rewrites no row. The old
-- process never writes this value; it only has to survive READING it, which
-- it does by matching nobody.
ALTER TABLE `telegram_group_mapping`
  MODIFY COLUMN `mapping_type`
    ENUM('ALL_EMPLOYEES','OUTLET','DESIGNATION','DEPARTMENT','COMPOSITE') NOT NULL
    COMMENT 'Legacy shape, kept for the old process until a later contract migration. COMPOSITE = see the rule_* columns; the old matcher does not recognise it and so matches nobody';

ALTER TABLE `telegram_group_mapping`
  ADD UNIQUE KEY `uq_tgm_group_rule`
    (`telegram_group_id`, `rule_outlet_id`, `rule_department_id`, `rule_designation_id`);
