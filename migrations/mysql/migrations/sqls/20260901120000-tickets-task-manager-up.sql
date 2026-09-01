-- =====================================================================
-- Turn `tickets` into a unified work-item store: raised tickets AND tasks
-- =====================================================================

-- 1. Extend the ticket row -------------------------------------------------
ALTER TABLE tickets
  ADD COLUMN item_type ENUM('ticket','task') NOT NULL DEFAULT 'ticket' AFTER title,
  ADD COLUMN is_template TINYINT(1) NOT NULL DEFAULT 0 AFTER item_type,
  ADD COLUMN due_date DATE NULL AFTER priority,
  ADD COLUMN parent_id BIGINT NULL AFTER department_id,
  ADD COLUMN closed_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at;

ALTER TABLE tickets
  ADD CONSTRAINT fk_tickets_parent
  FOREIGN KEY (parent_id) REFERENCES tickets(id) ON DELETE SET NULL;

CREATE INDEX idx_tickets_item_type ON tickets(item_type, is_template);
CREATE INDEX idx_tickets_due_date ON tickets(due_date);
CREATE INDEX idx_tickets_parent ON tickets(parent_id);

-- Backfill closed_at so existing closed tickets report a resolution time
UPDATE tickets SET closed_at = updated_at WHERE status = 'closed' AND closed_at IS NULL;

-- 2. Checklist steps inside an item ----------------------------------------
CREATE TABLE ticket_checklist_items (
    checklist_item_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_id         BIGINT NOT NULL,
    title             VARCHAR(255) NOT NULL,
    is_done           TINYINT(1) NOT NULL DEFAULT 0,
    done_by           INT(11) NULL,
    done_at           TIMESTAMP NULL DEFAULT NULL,
    position          INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX idx_checklist_ticket ON ticket_checklist_items(ticket_id, position);

-- 3. Comment thread ---------------------------------------------------------
CREATE TABLE ticket_comments (
    comment_id  BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_id   BIGINT NOT NULL,
    employee_id INT(11) NULL,
    comment     TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX idx_comments_ticket ON ticket_comments(ticket_id, created_at);

-- 4. Activity log -----------------------------------------------------------
CREATE TABLE ticket_activity (
    activity_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_id   BIGINT NOT NULL,
    employee_id INT(11) NULL,
    field       VARCHAR(64) NOT NULL,
    old_value   VARCHAR(255) NULL,
    new_value   VARCHAR(255) NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX idx_activity_ticket ON ticket_activity(ticket_id, created_at);

-- 5. Recurring tasks --------------------------------------------------------
-- A recurrence points at a template ticket (is_template = 1, hidden from lists).
-- The scheduler clones the template into a real task on each due day.
CREATE TABLE ticket_recurrences (
    recurrence_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    template_ticket_id BIGINT NOT NULL,
    frequency          ENUM('daily','weekly','monthly') NOT NULL,
    interval_value     INT NOT NULL DEFAULT 1,
    day_of_week        TINYINT NULL,
    day_of_month       TINYINT NULL,
    due_in_days        INT NOT NULL DEFAULT 0,
    next_run_on        DATE NOT NULL,
    last_created_on    DATE NULL,
    is_active          TINYINT(1) NOT NULL DEFAULT 1,
    created_by         INT(11) NULL,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (template_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX idx_recurrence_due ON ticket_recurrences(is_active, next_run_on);

-- 6. Permissions ------------------------------------------------------------
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_tasks');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_tasks');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('edit_tickets');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('delete_tickets');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('manage_recurring_tasks');
