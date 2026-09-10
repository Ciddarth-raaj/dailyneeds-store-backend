DROP TABLE IF EXISTS `offers_v3_talker_group_edit_log`;
DROP TABLE IF EXISTS `offers_v3_talker_proof_images`;
DROP TABLE IF EXISTS `offers_v3_talker_proofs`;
DROP TABLE IF EXISTS `offers_v3_talker_group_locations`;
DROP TABLE IF EXISTS `offers_v3_talker_group_suggested_items`;
DROP TABLE IF EXISTS `offers_v3_talker_group_items`;
DROP TABLE IF EXISTS `offers_v3_talker_groups`;

DELETE FROM `all_permissions`
WHERE `permission_key` IN (
  'view_offers_v3_talker_proofs',
  'add_offers_v3_talker_proofs',
  'verify_offers_v3_talker_proofs',
  'manage_offers_v3_talker_groups'
);
