const logger = require("../utils/logger");

/** Columns a caller is allowed to sort the list by. */
const SORTABLE = {
  id: "tickets.id",
  title: "tickets.title",
  status: "tickets.status",
  priority: "tickets.priority",
  due_date: "tickets.due_date",
  created_at: "tickets.created_at",
  updated_at: "tickets.updated_at",
};

/** Priority order for "most urgent first" sorting, since the enum is alphabetical. */
const PRIORITY_RANK = `FIELD(tickets.priority, 'urgent', 'high', 'medium', 'low')`;

const ITEM_SELECT = `
  tickets.*,
  creator.employee_name       AS created_by_name,
  creator.telegram_username   AS created_by_telegram_username,
  outlets.outlet_name,
  telegram_departments.department AS department_name,
  assignee.employee_name      AS assigned_to_name,
  assignee.telegram_username  AS assigned_to_telegram_username`;

const ITEM_JOINS = `
  FROM tickets
  LEFT JOIN new_employee AS creator  ON creator.employee_id  = tickets.created_by
  LEFT JOIN outlets                  ON outlets.outlet_id    = tickets.outlet_id
  LEFT JOIN telegram_departments     ON telegram_departments.id = tickets.department_id
  LEFT JOIN new_employee AS assignee ON assignee.employee_id = tickets.assigned_to`;

class TicketRepository {
  constructor(db) {
    this.db = db;
  }

  /** Runs a query, logging failures the same way across every method. */
  run(code, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.TICKET",
            code: `REPOSITORY.TICKET.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * Builds the shared WHERE clause for list and count so the two can never drift.
   * Template rows are hidden unless explicitly asked for.
   */
  buildFilters(filters = {}) {
    let clause = ` WHERE tickets.is_template = ${filters.is_template ? 1 : 0}`;
    const params = [];

    const eq = (column, value) => {
      if (value === undefined || value === null || value === "") return;
      clause += ` AND ${column} = ?`;
      params.push(value);
    };

    eq("tickets.item_type", filters.item_type);
    eq("tickets.status", filters.status);
    eq("tickets.priority", filters.priority);
    eq("tickets.outlet_id", filters.outlet_id);
    eq("tickets.created_by", filters.created_by);
    eq("tickets.assigned_to", filters.assigned_to);
    eq("tickets.department_id", filters.department_id);
    eq("tickets.parent_id", filters.parent_id);

    if (filters.unassigned) {
      clause += ` AND tickets.assigned_to IS NULL`;
    }

    // "Anything still open" — the default supervisor view.
    if (filters.is_open) {
      clause += ` AND tickets.status <> 'closed'`;
    }

    if (filters.overdue) {
      clause += ` AND tickets.due_date IS NOT NULL
                  AND tickets.due_date < CURDATE()
                  AND tickets.status <> 'closed'`;
    }

    if (filters.due_before) {
      clause += ` AND tickets.due_date IS NOT NULL AND tickets.due_date <= ?`;
      params.push(filters.due_before);
    }

    if (filters.due_after) {
      clause += ` AND tickets.due_date IS NOT NULL AND tickets.due_date >= ?`;
      params.push(filters.due_after);
    }

    // Either party — used by the "My Work" view.
    if (filters.involving) {
      clause += ` AND (tickets.assigned_to = ? OR tickets.created_by = ?)`;
      params.push(filters.involving, filters.involving);
    }

    if (filters.search) {
      clause += ` AND (tickets.title LIKE ? OR tickets.description LIKE ?)`;
      const term = `%${filters.search}%`;
      params.push(term, term);
    }

    return { clause, params };
  }

  buildOrderBy(sortBy, sortDir) {
    const direction = String(sortDir).toLowerCase() === "asc" ? "ASC" : "DESC";

    if (sortBy === "priority") {
      return ` ORDER BY ${PRIORITY_RANK} ${direction === "DESC" ? "DESC" : "ASC"}`;
    }

    // Due items first, and rows with no due date always last rather than
    // sorting as if they were due in 1970.
    if (sortBy === "due_date") {
      return ` ORDER BY tickets.due_date IS NULL, tickets.due_date ${direction}`;
    }

    const column = SORTABLE[sortBy] || "tickets.created_at";
    return ` ORDER BY ${column} ${direction}`;
  }

  create(ticket) {
    return this.run(
      "CREATE",
      `INSERT INTO tickets
         (title, item_type, is_template, description, status, priority, due_date,
          outlet_id, created_by, assigned_to, department_id, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        ticket.title,
        ticket.item_type || "ticket",
        ticket.is_template ? 1 : 0,
        ticket.description,
        ticket.status || "open",
        ticket.priority || "medium",
        ticket.due_date || null,
        ticket.outlet_id ?? null,
        ticket.created_by,
        ticket.assigned_to ?? null,
        ticket.department_id ?? null,
        ticket.parent_id ?? null,
      ]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getAll(filters, limit, offset, sortBy, sortDir) {
    const { clause, params } = this.buildFilters(filters);

    // Checklist progress is aggregated in SQL so the list never needs a
    // follow-up query per row.
    const sql = `
      SELECT ${ITEM_SELECT},
        (SELECT COUNT(*) FROM ticket_checklist_items c
          WHERE c.ticket_id = tickets.id) AS checklist_total,
        (SELECT COUNT(*) FROM ticket_checklist_items c
          WHERE c.ticket_id = tickets.id AND c.is_done = 1) AS checklist_done,
        (SELECT COUNT(*) FROM ticket_comments cm
          WHERE cm.ticket_id = tickets.id) AS comment_count,
        (SELECT COUNT(*) FROM ticket_images ti
          WHERE ti.ticket_id = tickets.id) AS image_count
      ${ITEM_JOINS}
      ${clause}
      ${this.buildOrderBy(sortBy, sortDir)}
      LIMIT ? OFFSET ?`;

    return this.run("GETALL", sql, [...params, limit, offset]);
  }

  getCount(filters) {
    const { clause, params } = this.buildFilters(filters);
    return this.run(
      "GETCOUNT",
      `SELECT COUNT(*) AS count ${ITEM_JOINS} ${clause}`,
      params
    ).then((docs) => docs[0].count);
  }

  /** Status/priority tallies for the dashboard strip, honouring the same filters. */
  getSummary(filters) {
    const { clause, params } = this.buildFilters(filters);
    return this.run(
      "GETSUMMARY",
      `SELECT
         COUNT(*) AS total,
         SUM(tickets.status = 'open')        AS open_count,
         SUM(tickets.status = 'in_progress') AS in_progress_count,
         SUM(tickets.status = 'closed')      AS closed_count,
         SUM(tickets.assigned_to IS NULL AND tickets.status <> 'closed') AS unassigned_count,
         SUM(tickets.priority IN ('high','urgent') AND tickets.status <> 'closed') AS high_priority_count,
         SUM(tickets.due_date IS NOT NULL
             AND tickets.due_date < CURDATE()
             AND tickets.status <> 'closed') AS overdue_count,
         SUM(tickets.due_date = CURDATE() AND tickets.status <> 'closed') AS due_today_count
       ${ITEM_JOINS} ${clause}`,
      params
    ).then((docs) => docs[0]);
  }

  getById(id) {
    return this.run(
      "GETBYID",
      `SELECT ${ITEM_SELECT} ${ITEM_JOINS} WHERE tickets.id = ?`,
      [id]
    ).then((docs) => (docs.length > 0 ? docs[0] : null));
  }

  update(id, ticket) {
    const updateFields = [];
    const params = [];

    const set = (column, value) => {
      if (value === undefined) return;
      updateFields.push(`${column} = ?`);
      params.push(value);
    };

    set("title", ticket.title);
    set("description", ticket.description);
    set("status", ticket.status);
    set("priority", ticket.priority);
    set("due_date", ticket.due_date);
    set("outlet_id", ticket.outlet_id);
    set("assigned_to", ticket.assigned_to);
    set("department_id", ticket.department_id);
    set("item_type", ticket.item_type);

    // Stamp the resolution time on the transition into and out of closed, so
    // "how long did this take" is answerable.
    if (ticket.status === "closed") {
      updateFields.push(`closed_at = COALESCE(closed_at, NOW())`);
    } else if (ticket.status !== undefined) {
      updateFields.push(`closed_at = NULL`);
    }

    if (updateFields.length === 0) {
      return Promise.resolve({ code: 200, affectedRows: 0 });
    }

    updateFields.push(`updated_at = NOW()`);
    params.push(id);

    return this.run(
      "UPDATE",
      `UPDATE tickets SET ${updateFields.join(", ")} WHERE id = ?`,
      params
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  delete(id) {
    return this.run("DELETE", `DELETE FROM tickets WHERE id = ?`, [id]).then(
      (res) => ({ code: 200, affectedRows: res.affectedRows })
    );
  }

  // ---------------------------------------------------------------- images

  createImage(ticketId, s3Url) {
    return this.run(
      "IMAGE.CREATE",
      `INSERT INTO ticket_images (ticket_id, s3_url, created_at) VALUES (?, ?, NOW())`,
      [ticketId, s3Url]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getImagesByTicketId(ticketId) {
    return this.run(
      "IMAGE.GETBYTICKETID",
      `SELECT * FROM ticket_images WHERE ticket_id = ? ORDER BY created_at DESC`,
      [ticketId]
    );
  }

  /** One query for a whole page of tickets, instead of one query per ticket. */
  getImagesByTicketIds(ticketIds) {
    if (!ticketIds || ticketIds.length === 0) return Promise.resolve([]);
    const placeholders = ticketIds.map(() => "?").join(", ");
    return this.run(
      "IMAGE.GETBYTICKETIDS",
      `SELECT * FROM ticket_images
        WHERE ticket_id IN (${placeholders})
        ORDER BY created_at DESC`,
      ticketIds
    );
  }

  deleteImage(imageId) {
    return this.run(
      "IMAGE.DELETE",
      `DELETE FROM ticket_images WHERE image_id = ?`,
      [imageId]
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  // ------------------------------------------------------------- checklist

  createChecklistItem(ticketId, title, position) {
    return this.run(
      "CHECKLIST.CREATE",
      `INSERT INTO ticket_checklist_items (ticket_id, title, position, created_at)
       VALUES (?, ?, ?, NOW())`,
      [ticketId, title, position ?? 0]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getChecklistByTicketId(ticketId) {
    return this.run(
      "CHECKLIST.GETBYTICKETID",
      `SELECT c.*, e.employee_name AS done_by_name
         FROM ticket_checklist_items c
         LEFT JOIN new_employee e ON e.employee_id = c.done_by
        WHERE c.ticket_id = ?
        ORDER BY c.position ASC, c.checklist_item_id ASC`,
      [ticketId]
    );
  }

  getChecklistItemById(checklistItemId) {
    return this.run(
      "CHECKLIST.GETBYID",
      `SELECT * FROM ticket_checklist_items WHERE checklist_item_id = ?`,
      [checklistItemId]
    ).then((docs) => (docs.length > 0 ? docs[0] : null));
  }

  updateChecklistItem(checklistItemId, changes, employeeId) {
    const updateFields = [];
    const params = [];

    if (changes.title !== undefined) {
      updateFields.push(`title = ?`);
      params.push(changes.title);
    }

    if (changes.position !== undefined) {
      updateFields.push(`position = ?`);
      params.push(changes.position);
    }

    if (changes.is_done !== undefined) {
      const done = changes.is_done ? 1 : 0;
      updateFields.push(`is_done = ?`);
      params.push(done);
      updateFields.push(done ? `done_at = NOW()` : `done_at = NULL`);
      updateFields.push(`done_by = ?`);
      params.push(done ? employeeId ?? null : null);
    }

    if (updateFields.length === 0) {
      return Promise.resolve({ code: 200, affectedRows: 0 });
    }

    params.push(checklistItemId);

    return this.run(
      "CHECKLIST.UPDATE",
      `UPDATE ticket_checklist_items SET ${updateFields.join(
        ", "
      )} WHERE checklist_item_id = ?`,
      params
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  deleteChecklistItem(checklistItemId) {
    return this.run(
      "CHECKLIST.DELETE",
      `DELETE FROM ticket_checklist_items WHERE checklist_item_id = ?`,
      [checklistItemId]
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  // -------------------------------------------------------------- comments

  createComment(ticketId, employeeId, comment) {
    return this.run(
      "COMMENT.CREATE",
      `INSERT INTO ticket_comments (ticket_id, employee_id, comment, created_at)
       VALUES (?, ?, ?, NOW())`,
      [ticketId, employeeId ?? null, comment]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getCommentsByTicketId(ticketId) {
    return this.run(
      "COMMENT.GETBYTICKETID",
      `SELECT c.*, e.employee_name, e.employee_image, e.telegram_username
         FROM ticket_comments c
         LEFT JOIN new_employee e ON e.employee_id = c.employee_id
        WHERE c.ticket_id = ?
        ORDER BY c.created_at ASC`,
      [ticketId]
    );
  }

  getCommentById(commentId) {
    return this.run(
      "COMMENT.GETBYID",
      `SELECT * FROM ticket_comments WHERE comment_id = ?`,
      [commentId]
    ).then((docs) => (docs.length > 0 ? docs[0] : null));
  }

  deleteComment(commentId) {
    return this.run(
      "COMMENT.DELETE",
      `DELETE FROM ticket_comments WHERE comment_id = ?`,
      [commentId]
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  // -------------------------------------------------------------- activity

  createActivity(ticketId, employeeId, field, oldValue, newValue) {
    return this.run(
      "ACTIVITY.CREATE",
      `INSERT INTO ticket_activity
         (ticket_id, employee_id, field, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        ticketId,
        employeeId ?? null,
        field,
        oldValue === null || oldValue === undefined ? null : String(oldValue),
        newValue === null || newValue === undefined ? null : String(newValue),
      ]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getActivityByTicketId(ticketId) {
    return this.run(
      "ACTIVITY.GETBYTICKETID",
      `SELECT a.*, e.employee_name
         FROM ticket_activity a
         LEFT JOIN new_employee e ON e.employee_id = a.employee_id
        WHERE a.ticket_id = ?
        ORDER BY a.created_at ASC`,
      [ticketId]
    );
  }

  // ------------------------------------------------------------ recurrence

  createRecurrence(recurrence) {
    return this.run(
      "RECURRENCE.CREATE",
      `INSERT INTO ticket_recurrences
         (template_ticket_id, frequency, interval_value, day_of_week, day_of_month,
          due_in_days, next_run_on, is_active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        recurrence.template_ticket_id,
        recurrence.frequency,
        recurrence.interval_value || 1,
        recurrence.day_of_week ?? null,
        recurrence.day_of_month ?? null,
        recurrence.due_in_days ?? 0,
        recurrence.next_run_on,
        recurrence.is_active === false ? 0 : 1,
        recurrence.created_by ?? null,
      ]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getAllRecurrences() {
    return this.run(
      "RECURRENCE.GETALL",
      `SELECT r.*,
              tickets.title       AS template_title,
              tickets.description AS template_description,
              tickets.priority    AS template_priority,
              tickets.outlet_id,
              tickets.department_id,
              tickets.assigned_to,
              outlets.outlet_name,
              telegram_departments.department AS department_name,
              assignee.employee_name AS assigned_to_name
         FROM ticket_recurrences r
         JOIN tickets ON tickets.id = r.template_ticket_id
         LEFT JOIN outlets              ON outlets.outlet_id = tickets.outlet_id
         LEFT JOIN telegram_departments ON telegram_departments.id = tickets.department_id
         LEFT JOIN new_employee AS assignee ON assignee.employee_id = tickets.assigned_to
        ORDER BY r.is_active DESC, r.next_run_on ASC`
    );
  }

  getRecurrenceById(recurrenceId) {
    return this.run(
      "RECURRENCE.GETBYID",
      `SELECT * FROM ticket_recurrences WHERE recurrence_id = ?`,
      [recurrenceId]
    ).then((docs) => (docs.length > 0 ? docs[0] : null));
  }

  /** Active recurrences whose next run has arrived (or was missed). */
  getDueRecurrences() {
    return this.run(
      "RECURRENCE.GETDUE",
      `SELECT * FROM ticket_recurrences
        WHERE is_active = 1 AND next_run_on <= CURDATE()
        ORDER BY next_run_on ASC`
    );
  }

  updateRecurrence(recurrenceId, changes) {
    const updateFields = [];
    const params = [];

    const set = (column, value) => {
      if (value === undefined) return;
      updateFields.push(`${column} = ?`);
      params.push(value);
    };

    set("frequency", changes.frequency);
    set("interval_value", changes.interval_value);
    set("day_of_week", changes.day_of_week);
    set("day_of_month", changes.day_of_month);
    set("due_in_days", changes.due_in_days);
    set("next_run_on", changes.next_run_on);
    set("last_created_on", changes.last_created_on);

    if (changes.is_active !== undefined) {
      updateFields.push(`is_active = ?`);
      params.push(changes.is_active ? 1 : 0);
    }

    if (updateFields.length === 0) {
      return Promise.resolve({ code: 200, affectedRows: 0 });
    }

    updateFields.push(`updated_at = NOW()`);
    params.push(recurrenceId);

    return this.run(
      "RECURRENCE.UPDATE",
      `UPDATE ticket_recurrences SET ${updateFields.join(
        ", "
      )} WHERE recurrence_id = ?`,
      params
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  deleteRecurrence(recurrenceId) {
    return this.run(
      "RECURRENCE.DELETE",
      `DELETE FROM ticket_recurrences WHERE recurrence_id = ?`,
      [recurrenceId]
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  /** Open, overdue items with an assignee — the input to the daily nudge. */
  getOverdueForReminder() {
    return this.run(
      "GETOVERDUE",
      `SELECT ${ITEM_SELECT},
              DATEDIFF(CURDATE(), tickets.due_date) AS days_overdue
       ${ITEM_JOINS}
        WHERE tickets.is_template = 0
          AND tickets.status <> 'closed'
          AND tickets.due_date IS NOT NULL
          AND tickets.due_date < CURDATE()
        ORDER BY tickets.due_date ASC`
    );
  }
}

module.exports = (db) => {
  return new TicketRepository(db);
};
