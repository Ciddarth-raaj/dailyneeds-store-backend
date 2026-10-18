-- Branch master: RetailPilot's store slug for each outlet, next to
-- gofrugal_id. The RetailPilot purchase sync maps invoices to outlets with it.
-- Values are RetailPilot's masterhub.stores.slug, whose external_id is our
-- outlet_id.
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
