-- Back to VARCHAR(45).
--
-- LOSSLESS IN THE ONLY DIRECTION THAT MATTERS. Every value is left as the ISO
-- text `YYYY-MM-DD`, which is one of the two shapes the column already held
-- and the shape `utils/joining_date.js#JOINED_ON` reads first - so the
-- application works identically after a rollback. What a rollback does NOT
-- restore is the original spelling of a long-form value ("05 September 2021"):
-- that is a representation, not a fact, and the up migration deliberately
-- stopped storing it. Nobody's joining DATE changes in either direction.
SET @is_date = (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                 WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                   AND `COLUMN_NAME` = 'date_of_joining' AND `DATA_TYPE` = 'date');

SET @revert = IF(@is_date > 0,
  'ALTER TABLE `new_employee` MODIFY COLUMN `date_of_joining` VARCHAR(45) NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @revert;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
