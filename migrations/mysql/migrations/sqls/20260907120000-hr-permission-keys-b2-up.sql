-- Stage 0B / B2 — the four permission keys the HR authorisation mapping needs
-- that did not already exist. Everything else in the mapping reuses a key
-- that is already in all_permissions.
--
--   view_employee_sensitive  see bank / PAN / Aadhaar / UAN / PF / ESI /
--                            salary fields (B2 gates the Aadhaar document
--                            route with it; field-level filtering is B3)
--   edit_employee_sensitive  write those fields (declared here so B3 has it;
--                            no route uses it yet)
--   add_documents            create / update / approve employee documents
--                            (only view_documents existed)
--   add_stores               outlet writes (only view_stores existed)
--
-- Granting a key to a designation is an administrator's decision made in the
-- app. Nothing is granted here: this migration only declares that the keys
-- exist, so no designation gains or loses access when it runs. Each insert is
-- idempotent because all_permissions has no unique key on permission_key.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_employee_sensitive' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_employee_sensitive');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_employee_sensitive' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_employee_sensitive');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'add_documents' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'add_documents');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'add_stores' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'add_stores');
