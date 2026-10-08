// repository/transporter_master.js
const logger = require("../utils/logger");
const { withTransaction } = require("../utils/transaction");

/**
 * The Transporter Master and its audit trail.
 *
 * There is no DELETE here, deliberately: a transporter that is no longer
 * used is made inactive. LR follow-ups (and their manual entries) reference it by
 * key, and the foreign keys would refuse the delete anyway.
 */

const SELECT = `
  t.*,
  creator.employee_name AS created_by_name,
  updater.employee_name AS updated_by_name`;

const JOINS = `
  FROM transporter_master t
  LEFT JOIN new_employee AS creator ON creator.employee_id = t.created_by
  LEFT JOIN new_employee AS updater ON updater.employee_id = t.updated_by`;

class TransporterMasterRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = [], conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.TRANSPORTER_MASTER",
            code: `REPOSITORY.TRANSPORTER_MASTER.${code}`,
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

  transaction(work) {
    return withTransaction(this.db, work);
  }

  list({ is_active, search } = {}) {
    let clause = " WHERE 1 = 1";
    const params = [];
    if (is_active !== undefined && is_active !== null) {
      clause += " AND t.is_active = ?";
      params.push(is_active ? 1 : 0);
    }
    if (search) {
      const term = `%${search}%`;
      clause += " AND (t.transporter_name LIKE ? OR t.contact_no LIKE ? OR t.contact_person LIKE ?)";
      params.push(term, term, term);
    }
    return this.run(
      "LIST",
      `SELECT ${SELECT} ${JOINS} ${clause} ORDER BY t.is_active DESC, t.transporter_name ASC`,
      params
    );
  }

  getById(id, conn = null, { forUpdate = false } = {}) {
    if (forUpdate) {
      return this.run(
        "GETBYID.LOCK",
        `SELECT * FROM transporter_master WHERE transporter_id = ? FOR UPDATE`,
        [id],
        conn
      ).then((rows) => rows[0] || null);
    }
    return this.run("GETBYID", `SELECT ${SELECT} ${JOINS} WHERE t.transporter_id = ?`, [id], conn).then(
      (rows) => rows[0] || null
    );
  }

  findByNameKey(nameKey, conn = null) {
    return this.run(
      "BYNAMEKEY",
      `SELECT transporter_id, transporter_name, is_active
         FROM transporter_master WHERE transporter_name_key = ?`,
      [nameKey],
      conn
    ).then((rows) => rows[0] || null);
  }

  insert(row, conn = null) {
    return this.run(
      "INSERT",
      `INSERT INTO transporter_master
         (transporter_name, transporter_name_key, contact_no, alternate_contact_no,
          contact_person, is_active, remarks, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.transporter_name,
        row.transporter_name_key,
        row.contact_no,
        row.alternate_contact_no ?? null,
        row.contact_person ?? null,
        row.is_active === false ? 0 : 1,
        row.remarks ?? null,
        row.created_by ?? null,
        row.created_by ?? null,
      ],
      conn
    ).then((res) => res.insertId);
  }

  update(id, fields, conn = null) {
    const columns = Object.keys(fields);
    return this.run(
      "UPDATE",
      `UPDATE transporter_master SET ${columns.map((c) => `${c} = ?`).join(", ")}
        WHERE transporter_id = ?`,
      [...columns.map((c) => (fields[c] === undefined ? null : fields[c])), id],
      conn
    ).then((res) => res.affectedRows);
  }

  insertAudit(entries, conn = null) {
    if (!entries.length) return Promise.resolve(0);
    return this.run(
      "AUDIT.INSERT",
      `INSERT INTO transporter_master_audit
         (transporter_id, action, field, old_value, new_value, changed_by)
       VALUES ${entries.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      entries.flatMap((e) => [
        e.transporter_id,
        e.action,
        e.field,
        e.old_value === null || e.old_value === undefined ? null : String(e.old_value),
        e.new_value === null || e.new_value === undefined ? null : String(e.new_value),
        e.changed_by ?? null,
      ]),
      conn
    ).then((res) => res.affectedRows);
  }

  getAudit(id) {
    return this.run(
      "AUDIT.LIST",
      `SELECT a.*, e.employee_name AS changed_by_name
         FROM transporter_master_audit a
         LEFT JOIN new_employee e ON e.employee_id = a.changed_by
        WHERE a.transporter_id = ?
        ORDER BY a.changed_at DESC, a.transporter_audit_id DESC`,
      [id]
    );
  }

  /** How many records point at this transporter. Shown on the master. */
  usageCount(id) {
    return this.run(
      "USAGE",
      `SELECT
         (SELECT COUNT(*) FROM credit_purchases WHERE transporter_id = ?) AS credit_purchases,
         (SELECT COUNT(*) FROM lr_followup      WHERE transporter_id = ?) AS lr_followups`,
      [id, id]
    ).then((rows) => ({
      credit_purchases: Number(rows[0].credit_purchases || 0),
      lr_followups: Number(rows[0].lr_followups || 0),
    }));
  }
}

module.exports = (db) => new TransporterMasterRepository(db);
