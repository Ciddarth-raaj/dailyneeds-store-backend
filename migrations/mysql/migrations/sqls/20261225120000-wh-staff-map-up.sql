-- Who is who in RetailPilot: the pick & pack reports record who did each job
-- as a RetailPilot (Keypoint) user id. Each id is mapped to an employee by
-- hand on Warehouse Reports > Staff Mapping, so the analysis shows names.
CREATE TABLE wh_rp_staff_map (
    rp_user_id   VARCHAR(100) PRIMARY KEY COMMENT 'RetailPilot / Keypoint user id (state_machine.assigned_user)',
    employee_id  INT(11) NULL COMMENT 'new_employee.employee_id; NULL = not mapped',
    note         VARCHAR(255) NULL,
    updated_by   INT(11) NULL,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_wh_rp_staff_map_employee (employee_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_wh_staff_map' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_wh_staff_map');
