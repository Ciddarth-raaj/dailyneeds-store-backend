-- How the printed shelf talker looks: card size, logo placement, type sizes,
-- brand colours. One shared row rather than per-user, because every outlet's
-- signs should look the same and HQ prints them centrally.
--
-- Held as JSON in one column rather than a column per control: these are
-- presentation knobs that will be added to and dropped, and nothing joins or
-- filters on them. Defaults live in the application, so an absent row or a key
-- added after a save both fall back rather than rendering a blank sign.
CREATE TABLE `offers_v3_talker_print_settings` (
  `id` TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'always 1 - the primary key pins this to a single row',
  `settings` TEXT NOT NULL,
  `updated_by` INT(11) NULL DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
