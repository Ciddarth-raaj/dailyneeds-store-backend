const logger = require("../utils/logger");

class TicketRepository {
  constructor(db) {
    this.db = db;
  }

  create(ticket) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO tickets (title, description, status, priority, outlet_id, created_by, assigned_to, department_id, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          ticket.title,
          ticket.description,
          ticket.status || "open",
          ticket.priority || "medium",
          ticket.outlet_id,
          ticket.created_by,
          ticket.assigned_to,
          ticket.department_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TICKET",
              code: "REPOSITORY.TICKET.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  getAll(filters, limit, offset) {
    return new Promise((resolve, reject) => {
      let query = `SELECT tickets.*, 
                   new_employee.employee_name as created_by_name,
                   outlets.outlet_name,
                   telegram_departments.department as department_name,
                   assigned_employee.employee_name as assigned_to_name,
                   new_employee.telegram_username as assigned_to_telegram_username
                   FROM tickets 
                   LEFT JOIN new_employee ON new_employee.employee_id = tickets.created_by
                   LEFT JOIN outlets ON outlets.outlet_id = tickets.outlet_id
                   LEFT JOIN telegram_departments ON telegram_departments.id = tickets.department_id
                   LEFT JOIN new_employee as assigned_employee ON assigned_employee.employee_id = tickets.assigned_to
                   WHERE 1=1`;
      const params = [];

      if (filters.status) {
        query += ` AND tickets.status = ?`;
        params.push(filters.status);
      }

      if (filters.priority) {
        query += ` AND tickets.priority = ?`;
        params.push(filters.priority);
      }

      if (filters.outlet_id) {
        query += ` AND tickets.outlet_id = ?`;
        params.push(filters.outlet_id);
      }

      if (filters.created_by) {
        query += ` AND tickets.created_by = ?`;
        params.push(filters.created_by);
      }

      if (filters.assigned_to) {
        query += ` AND tickets.assigned_to = ?`;
        params.push(filters.assigned_to);
      }

      if (filters.department_id) {
        query += ` AND tickets.department_id = ?`;
        params.push(filters.department_id);
      }

      if (filters.search) {
        query += ` AND (tickets.title LIKE ? OR tickets.description LIKE ?)`;
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm);
      }

      query += ` ORDER BY tickets.created_at DESC LIMIT ${offset}, ${limit}`;

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.TICKET",
            code: "REPOSITORY.TICKET.GETALL",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }

  getById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT tickets.*, 
                     new_employee.employee_name as created_by_name,
                     outlets.outlet_name,
                     telegram_departments.department as department_name,
                     assigned_employee.employee_name as assigned_to_name,
                     assigned_employee.telegram_username as assigned_to_telegram_username
                     FROM tickets 
                     LEFT JOIN new_employee ON new_employee.employee_id = tickets.created_by
                     LEFT JOIN outlets ON outlets.outlet_id = tickets.outlet_id
                     LEFT JOIN telegram_departments ON telegram_departments.id = tickets.department_id
                     LEFT JOIN new_employee as assigned_employee ON assigned_employee.employee_id = tickets.assigned_to
                     WHERE tickets.id = ?`,
        [id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TICKET",
              code: "REPOSITORY.TICKET.GETBYID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs.length > 0 ? docs[0] : null);
        }
      );
    });
  }

  update(id, ticket) {
    return new Promise((resolve, reject) => {
      const updateFields = [];
      const params = [];

      if (ticket.title !== undefined) {
        updateFields.push(`title = ?`);
        params.push(ticket.title);
      }

      if (ticket.description !== undefined) {
        updateFields.push(`description = ?`);
        params.push(ticket.description);
      }

      if (ticket.status !== undefined) {
        updateFields.push(`status = ?`);
        params.push(ticket.status);
      }

      if (ticket.priority !== undefined) {
        updateFields.push(`priority = ?`);
        params.push(ticket.priority);
      }

      if (ticket.outlet_id !== undefined) {
        updateFields.push(`outlet_id = ?`);
        params.push(ticket.outlet_id);
      }

      if (ticket.assigned_to !== undefined) {
        updateFields.push(`assigned_to = ?`);
        params.push(ticket.assigned_to);
      }

      if (ticket.department_id !== undefined) {
        updateFields.push(`department_id = ?`);
        params.push(ticket.department_id);
      }

      updateFields.push(`updated_at = NOW()`);
      params.push(id);

      const query = `UPDATE tickets SET ${updateFields.join(
        ", "
      )} WHERE id = ?`;

      this.db.query(query, params, (err, res) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.TICKET",
            code: "REPOSITORY.TICKET.UPDATE",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({ code: 200, affectedRows: res.affectedRows });
      });
    });
  }

  delete(id) {
    return new Promise((resolve, reject) => {
      // First delete associated images
      this.db.query(
        `DELETE FROM ticket_images WHERE ticket_id = ?`,
        [id],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TICKET",
              code: "REPOSITORY.TICKET.DELETE.IMAGES",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          // Then delete the ticket
          this.db.query(
            `DELETE FROM tickets WHERE id = ?`,
            [id],
            (err2, res) => {
              if (err2) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.TICKET",
                  code: "REPOSITORY.TICKET.DELETE",
                  description: err2.toString(),
                  category: "",
                  ref: {},
                });
                reject(err2);
                return;
              }
              resolve({ code: 200, affectedRows: res.affectedRows });
            }
          );
        }
      );
    });
  }

  getCount(filters) {
    return new Promise((resolve, reject) => {
      let query = `SELECT COUNT(*) AS count FROM tickets WHERE 1=1`;
      const params = [];

      if (filters.status) {
        query += ` AND status = ?`;
        params.push(filters.status);
      }

      if (filters.priority) {
        query += ` AND priority = ?`;
        params.push(filters.priority);
      }

      if (filters.outlet_id) {
        query += ` AND outlet_id = ?`;
        params.push(filters.outlet_id);
      }

      if (filters.created_by) {
        query += ` AND created_by = ?`;
        params.push(filters.created_by);
      }

      if (filters.assigned_to) {
        query += ` AND assigned_to = ?`;
        params.push(filters.assigned_to);
      }

      if (filters.department_id) {
        query += ` AND department_id = ?`;
        params.push(filters.department_id);
      }

      if (filters.search) {
        query += ` AND (title LIKE ? OR description LIKE ?)`;
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm);
      }

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.TICKET",
            code: "REPOSITORY.TICKET.GETCOUNT",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs[0].count);
      });
    });
  }

  // Ticket Images methods
  createImage(ticketId, s3Url) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ticket_images (ticket_id, s3_url, created_at) VALUES (?, ?, NOW())`,
        [ticketId, s3Url],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TICKET",
              code: "REPOSITORY.TICKET.IMAGE.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  getImagesByTicketId(ticketId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM ticket_images WHERE ticket_id = ? ORDER BY created_at DESC`,
        [ticketId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TICKET",
              code: "REPOSITORY.TICKET.IMAGE.GETBYTICKETID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  deleteImage(imageId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ticket_images WHERE image_id = ?`,
        [imageId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TICKET",
              code: "REPOSITORY.TICKET.IMAGE.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new TicketRepository(db);
};
