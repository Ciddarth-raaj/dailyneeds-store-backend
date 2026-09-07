-- Removes the four keys and any grant of them. Safe: no other Stage 0B code
-- depends on a row existing, and a designation that held one simply stops
-- holding it (its other permissions are untouched).
DELETE FROM `permissions` WHERE `permission_key` IN ('view_employee_sensitive', 'edit_employee_sensitive', 'add_documents', 'add_stores');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('view_employee_sensitive', 'edit_employee_sensitive', 'add_documents', 'add_stores');
