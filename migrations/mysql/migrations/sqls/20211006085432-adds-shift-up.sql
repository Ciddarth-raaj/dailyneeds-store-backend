CREATE TABLE `shift_master` ( `shift_id` int NOT NULL AUTO_INCREMENT, `shift_name` varchar(150) NOT NULL, `shift_in_time` time NOT NULL, `shift_out_time` time NOT NULL, `status` int NOT NULL DEFAULT '0', PRIMARY KEY (`shift_id`));