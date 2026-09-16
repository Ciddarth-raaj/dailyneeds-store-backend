-- Drops both classification columns. Nothing else read them, so nothing else
-- breaks; any recorded values are lost, which is the honest cost of reversing
-- an additive column.
ALTER TABLE `new_employee`
  DROP COLUMN `employment_type`,
  DROP COLUMN `grade`;
