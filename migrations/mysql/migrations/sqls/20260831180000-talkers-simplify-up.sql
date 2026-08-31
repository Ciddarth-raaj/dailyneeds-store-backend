-- Talkers are created by HQ and printed by outlets. Nothing proposes them any
-- more, so there is nothing to review: a talker exists because someone made it,
-- which makes `draft` meaningless. Existing drafts become live rather than
-- vanishing.
UPDATE `offers_v3_talker_groups` SET `status` = 'published' WHERE `status` = 'draft';
ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `status` ENUM('published', 'ended') NOT NULL DEFAULT 'published';

-- Auto-derivation is gone, so every talker is made by hand.
ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `origin` ENUM('auto', 'manual') NOT NULL DEFAULT 'manual';

-- The two kinds a talker comes in, named as the people making them say it:
-- an individual article's card, or a card over a group of articles sharing one
-- brand offer. The column said 'brand', which named the offer rather than the
-- thing on the shelf.
UPDATE `offers_v3_talker_groups` SET `group_type` = 'brand' WHERE `group_type` NOT IN ('brand', 'individual');
ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `group_type` ENUM('brand', 'individual', 'group') NOT NULL DEFAULT 'group';
UPDATE `offers_v3_talker_groups` SET `group_type` = 'group' WHERE `group_type` = 'brand';
ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `group_type` ENUM('individual', 'group') NOT NULL DEFAULT 'group';

-- A talker's spot on the shelf falls into a handful of real kinds. Free text
-- drifted ("Aisle 3", "aisle3", "near billing"), which made it impossible to
-- ask whether every store had covered its end caps. The label survives as the
-- detail beside the type.
ALTER TABLE `offers_v3_talker_group_locations`
  ADD COLUMN `location_type` ENUM('aisle', 'floor_display', 'end_cap', 'other')
    NOT NULL DEFAULT 'other' AFTER `outlet_id`;

-- Only auto-derivation raised suggestions; with it gone nothing writes here.
DROP TABLE IF EXISTS `offers_v3_talker_group_suggested_items`;

-- Outlets print, HQ creates. Printing must not imply the right to edit.
INSERT INTO `all_permissions` (`permission_key`) VALUES ('print_offers_v3_talkers');
