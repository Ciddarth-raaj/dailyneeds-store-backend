ALTER TABLE `new_employee` 
CHANGE COLUMN `permanent_address` `permanent_address` LONGTEXT NOT NULL ,
CHANGE COLUMN `residential_address` `residential_address` LONGTEXT NOT NULL ,
CHANGE COLUMN `introducer_details` `introducer_details` LONGTEXT NULL DEFAULT NULL ,
CHANGE COLUMN `previous_experience` `previous_experience` LONGTEXT NULL DEFAULT NULL ;
