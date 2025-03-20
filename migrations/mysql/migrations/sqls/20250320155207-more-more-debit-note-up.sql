ALTER TABLE `debit_note_internal` ADD `round_off` FLOAT NOT NULL AFTER `mmh_mrc_refno`;
ALTER TABLE `debit_note_internal` CHANGE `round_off` `round_off` FLOAT NOT NULL DEFAULT 0.00;