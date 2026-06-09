ALTER TABLE purchase
  ADD COLUMN is_new TINYINT(1) NOT NULL DEFAULT 1 AFTER is_approved;

UPDATE purchase SET is_new = 0;

ALTER TABLE debit_note
  ADD COLUMN is_new TINYINT(1) NOT NULL DEFAULT 1 AFTER is_approved;

UPDATE debit_note SET is_new = 0;
