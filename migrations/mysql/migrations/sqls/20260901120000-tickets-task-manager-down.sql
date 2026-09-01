DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_tasks', 'add_tasks', 'edit_tickets', 'delete_tickets', 'manage_recurring_tasks'
);

DROP TABLE IF EXISTS ticket_recurrences;
DROP TABLE IF EXISTS ticket_activity;
DROP TABLE IF EXISTS ticket_comments;
DROP TABLE IF EXISTS ticket_checklist_items;

ALTER TABLE tickets DROP FOREIGN KEY fk_tickets_parent;
DROP INDEX idx_tickets_item_type ON tickets;
DROP INDEX idx_tickets_due_date ON tickets;
DROP INDEX idx_tickets_parent ON tickets;

ALTER TABLE tickets
  DROP COLUMN item_type,
  DROP COLUMN is_template,
  DROP COLUMN due_date,
  DROP COLUMN parent_id,
  DROP COLUMN closed_at;
