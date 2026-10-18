-- Branch master: RetailPilot's store slug for each outlet, next to
-- gofrugal_id. It is the only source of the RetailPilot store -> outlet map
-- (utils/retailpilot_branch_map.js). gofrugal_id is not touched.
-- Values are RetailPilot's masterhub.stores.slug, whose external_id is our
-- outlet_id.

-- GUARD - runs before any change. The IDs below are assigned by outlet_id,
-- so first confirm that each of outlets 2-7 is the branch it should be (by
-- name). If any one is not, the subquery returns two rows and MySQL stops
-- the migration with error 1242 "Subquery returns more than 1 row" - always,
-- whatever the sql_mode - before the column is added or any ID is written.
-- Fix the outlet (or this file) and run it again; nothing needs undoing.
SELECT (
  SELECT 'outlets 2-7 are not Warehouse, Kathirkamam, Vallalar Salai, Moolakulam, Muthialpet, ECR'
  FROM (SELECT 1 AS n UNION ALL SELECT 2) AS fail_twice
  WHERE (
    SELECT COUNT(*) FROM `outlets`
    WHERE (`outlet_id` = 2 AND LOWER(`outlet_name`) LIKE '%warehouse%')
       OR (`outlet_id` = 3 AND LOWER(`outlet_name`) LIKE '%kathirkamam%')
       OR (`outlet_id` = 4 AND LOWER(`outlet_name`) LIKE '%vallalar%')
       OR (`outlet_id` = 5 AND LOWER(`outlet_name`) LIKE '%moolakulam%')
       OR (`outlet_id` = 6 AND LOWER(`outlet_name`) LIKE '%muthialpet%')
       OR (`outlet_id` = 7 AND (LOWER(`outlet_name`) LIKE '%ecr%' OR LOWER(`outlet_name`) LIKE '%east coast%'))
  ) <> 6
) AS retailpilot_id_outlet_guard;

ALTER TABLE `outlets`
  ADD COLUMN `retailpilot_id` VARCHAR(50) NULL DEFAULT NULL AFTER `gofrugal_id`,
  ADD UNIQUE KEY `uniq_outlets_retailpilot_id` (`retailpilot_id`);

UPDATE `outlets`
SET `retailpilot_id` = CASE `outlet_id`
  WHEN 2 THEN '9rJMC'
  WHEN 3 THEN 'huABy'
  WHEN 4 THEN 'FuUGY'
  WHEN 5 THEN 'sooWy'
  WHEN 6 THEN 'rnMT1'
  WHEN 7 THEN 'kKFom'
END
WHERE `outlet_id` IN (2, 3, 4, 5, 6, 7);
