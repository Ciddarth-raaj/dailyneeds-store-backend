const logger = require("../utils/logger");

/**
 * Stage 0C / C2 — the local employee master.
 *
 * From C2 onward dnds.co.in owns the employee lifecycle. This layer holds the
 * SQL for the four HR actions - create, edit, resign, rejoin - and the reads
 * the HR screens need. It does NOT decide anything about employment periods:
 * every transition is decided by the C1c reconciler, which this repository's
 * transaction is handed to so that the master change and the period it
 * implies commit or roll back together.
 *
 * IDENTITY. `new_employee.employee_id` is `INT NOT NULL AUTO_INCREMENT
 * PRIMARY KEY`, so the database already has a concurrency-safe, restart-safe,
 * non-reusing allocator and C2 adds no second one: a local create omits the
 * column and takes `insertId`. Two simultaneous creates cannot collide,
 * because InnoDB serialises the counter; the value is persisted across
 * restarts on MySQL 8.0+; and it is never handed out twice. No existing
 * employee is renumbered. See the C2 migration for the one-time seed that
 * puts the counter above the historical maximum.
 *
 * `employee_id` never appears in an UPDATE in this file. It is the identity
 * invariant, and the edit path cannot reach it.
 */

/** Columns HR may edit. Deliberately excludes everything lifecycle-controlled. */
const EDITABLE_FIELDS = [
  "employee_name",
  "father_name",
  "dob",
  "gender",
  "marital_status",
  "marriage_date",
  "spouse_name",
  "permanent_address",
  "residential_address",
  "primary_contact_number",
  "alternate_contact_number",
  "email_id",
  "blood_group",
  "qualification",
  "introducer_name",
  "introducer_details",
  "previous_experience",
  "additional_course",
  "uniform_qty",
  "employee_image",
  "telegram_username",
  "online_portal",
  "store_id",
  "department_id",
  "designation_id",
  "shift_id",
];

/**
 * Editing any of these changes what a token is allowed to do, because the
 * auth middleware and the permission cache read designation and store from
 * the session. An existing JWT would otherwise keep the old authorisation
 * until it expired.
 */
const SECURITY_RELEVANT_FIELDS = ["designation_id", "store_id"];

/**
 * Never settable through the generic edit path. `status`, the two dates and
 * the identity are lifecycle state, owned by create / resign / rejoin.
 */
const LIFECYCLE_CONTROLLED_FIELDS = [
  "employee_id",
  "status",
  "date_of_joining",
  "resignation_date",
  "period_no",
  "period_state",
  "joined_on",
  "ended_on",
];

/** The canonical status values the application already uses. */
const STATUS = { ACTIVE: 1, INACTIVE: 0 };

/* --------------------------------------------------------- pool plumbing -- */
const getConnectionAsync = (db) =>
  new Promise((resolve, reject) =>
    db.getConnection((err, connection) => (err ? reject(err) : resolve(connection)))
  );
const queryAsync = (conn, sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const beginAsync = (conn) =>
  new Promise((resolve, reject) => conn.beginTransaction((err) => (err ? reject(err) : resolve())));
const commitAsync = (conn) =>
  new Promise((resolve, reject) => conn.commit((err) => (err ? reject(err) : resolve())));
const rollbackAsync = (conn) => new Promise((resolve) => conn.rollback(() => resolve()));

class EmployeeMasterRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_MASTER",
      code: `REPOSITORY.EMPLOYEE_MASTER.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  /**
   * One transaction on one pooled connection, shaped exactly like the C1c
   * repository's so the same `tx` object can be handed straight to the
   * reconciler. That is what makes "master change + period change" one
   * logical operation rather than two hopeful ones.
   */
  async withTransaction(fn) {
    let conn;
    try {
      conn = await getConnectionAsync(this.db);
    } catch (err) {
      this._log("GET-CONNECTION", err);
      throw err;
    }
    const tx = { query: (sql, params) => queryAsync(conn, sql, params) };
    try {
      await beginAsync(conn);
    } catch (err) {
      conn.release();
      this._log("BEGIN", err);
      throw err;
    }
    try {
      const result = await fn(tx);
      await commitAsync(conn);
      return result;
    } catch (err) {
      await rollbackAsync(conn);
      this._log("TRANSACTION", err);
      throw err;
    } finally {
      conn.release();
    }
  }

  /* ------------------------------------------------------------- writes -- */

  /**
   * Creates the employee row and returns the id the DATABASE allocated.
   * `employee_id` is deliberately absent from the column list: supplying it
   * is what would create a race, and AUTO_INCREMENT is what removes one.
   */
  async createEmployee(tx, fields) {
    const columns = Object.keys(fields);
    if (columns.includes("employee_id")) {
      throw new Error("createEmployee must not be given an employee_id; the database allocates it");
    }
    const res = await tx.query(
      `INSERT INTO new_employee (${columns.map((c) => `\`${c}\``).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => fields[c])
    );
    return res.insertId;
  }

  /** Locks the master row, so two HR actions on one employee serialise. */
  async lockEmployee(tx, employeeId) {
    const rows = await tx.query(
      `SELECT employee_id, employee_name, status, resignation_date, date_of_joining,
              store_id, designation_id, department_id, shift_id
         FROM new_employee WHERE employee_id = ? FOR UPDATE`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** A partial update of ordinary HR fields. Refuses anything lifecycle-owned. */
  async updateEmployee(tx, employeeId, fields) {
    const columns = Object.keys(fields);
    if (columns.length === 0) return 0;
    for (const c of columns) {
      if (LIFECYCLE_CONTROLLED_FIELDS.includes(c)) {
        throw new Error(`'${c}' is lifecycle-controlled and cannot be set through an edit`);
      }
      if (!EDITABLE_FIELDS.includes(c)) {
        throw new Error(`'${c}' is not an editable employee field`);
      }
    }
    const res = await tx.query(
      `UPDATE new_employee SET ${columns.map((c) => `\`${c}\` = ?`).join(", ")}
        WHERE employee_id = ?`,
      [...columns.map((c) => fields[c]), employeeId]
    );
    return res.affectedRows;
  }

  /**
   * Marks the employee as having left. Guarded by `status = ?` in the WHERE
   * so a second concurrent resignation affects zero rows rather than
   * overwriting the first one's date; the caller checks affectedRows.
   */
  async markResigned(tx, employeeId, endedOn) {
    const res = await tx.query(
      `UPDATE new_employee SET status = ?, resignation_date = ?
        WHERE employee_id = ? AND status = ?`,
      [STATUS.INACTIVE, endedOn, employeeId, STATUS.ACTIVE]
    );
    return res.affectedRows;
  }

  /**
   * Marks the employee as employed again, and moves `date_of_joining` to the
   * rejoin date - that column describes the CURRENT spell, which is now the
   * new one. The historical value is not lost: it is already recorded on the
   * earlier period, which nothing here touches.
   */
  async markRejoined(tx, employeeId, joinedOn) {
    const res = await tx.query(
      `UPDATE new_employee SET status = ?, resignation_date = NULL, date_of_joining = ?
        WHERE employee_id = ? AND status <> ?`,
      [STATUS.ACTIVE, joinedOn, employeeId, STATUS.ACTIVE]
    );
    return res.affectedRows;
  }

  /**
   * The supporting resignation record, linked to the employee and the period
   * it belongs to. Only ever written for a resignation C2 itself performed,
   * where both links are known; the old name-keyed rows are never touched.
   */
  async createResignationRecord(tx, { employee_id, period_id, employee_name, reason, reason_type, resignation_date }) {
    const res = await tx.query(
      `INSERT INTO resignation
         (employee_id, period_id, employee_name, reason, reason_type, resignation_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employee_id, period_id, employee_name, reason, reason_type, resignation_date]
    );
    return res.insertId;
  }

  /** Stage 0A revocation, inside the caller's transaction so a rollback undoes it. */
  async bumpTokenValidFrom(tx, employeeId) {
    const res = await tx.query(
      "UPDATE `user` SET `token_valid_from` = NOW() WHERE `employee_id` = ? AND `is_system_account` = 0",
      [employeeId]
    );
    return res.affectedRows;
  }

  /* -------------------------------------------------------------- reads -- */

  /** The employee's periods, oldest first. No sensitive column is selected. */
  async getPeriods(employeeId) {
    return this._read(
      "GET-PERIODS",
      `SELECT period_id, period_no, period_state,
              DATE_FORMAT(joined_on, '%Y-%m-%d') AS joined_on,
              DATE_FORMAT(ended_on, '%Y-%m-%d')  AS ended_on,
              end_reason_type, end_note, source, needs_review, created_at
         FROM employee_employment_period
        WHERE employee_id = ? ORDER BY period_no`,
      [employeeId]
    );
  }

  async getEvents(employeeId) {
    return this._read(
      "GET-EVENTS",
      `SELECT event_id, period_id, event_type,
              JSON_UNQUOTE(JSON_EXTRACT(detail_json, '$.reason')) AS reason,
              actor_employee_id, created_at
         FROM employee_lifecycle_event
        WHERE employee_id = ? ORDER BY event_id`,
      [employeeId]
    );
  }

  /**
   * The header for the HR history screen. Every column is named, and the
   * list is checked by test against the B3 sensitive-field list, so a future
   * join cannot quietly add salary or a bank account to this response.
   */
  async getEmployeeHeader(employeeId) {
    const rows = await this._read(
      "GET-HEADER",
      `SELECT ne.employee_id, ne.employee_name, ne.status,
              ne.date_of_joining, DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date,
              ne.store_id, ne.designation_id, ne.department_id, ne.shift_id,
              o.outlet_nickname, d.designation_name, dep.department_name
         FROM new_employee ne
         LEFT JOIN outlets o     ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN department dep ON dep.department_id = ne.department_id
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * The review queue: periods C1b or C1c could not date. Read-only, and
   * nothing here repairs anything - the 518 historical rows stay exactly as
   * they are until the archived Digisme export is imported.
   */
  async getReviewList({ limit = 200, offset = 0 } = {}) {
    return this._read(
      "GET-REVIEW-LIST",
      `SELECT p.employee_id, p.period_id, p.period_no, p.period_state, p.source,
              DATE_FORMAT(p.joined_on, '%Y-%m-%d') AS joined_on,
              DATE_FORMAT(p.ended_on, '%Y-%m-%d')  AS ended_on,
              CASE
                WHEN p.joined_on IS NULL AND p.period_state = 'closed' AND p.ended_on IS NULL
                  THEN 'missing_joining_and_end_date'
                WHEN p.joined_on IS NULL THEN 'missing_joining_date'
                WHEN p.period_state = 'closed' AND p.ended_on IS NULL THEN 'missing_end_date'
                ELSE 'other'
              END AS warning_type
         FROM employee_employment_period p
        WHERE p.needs_review = 1
        ORDER BY p.employee_id, p.period_no
        LIMIT ? OFFSET ?`,
      [Number(limit), Number(offset)]
    );
  }

  async countReviewList() {
    const rows = await this._read(
      "COUNT-REVIEW-LIST",
      "SELECT COUNT(*) AS total FROM employee_employment_period WHERE needs_review = 1",
      []
    );
    return rows && rows[0] ? Number(rows[0].total) : 0;
  }

  _read(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }
}

module.exports = (db) => new EmployeeMasterRepository(db);
module.exports.EmployeeMasterRepository = EmployeeMasterRepository;
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
module.exports.SECURITY_RELEVANT_FIELDS = SECURITY_RELEVANT_FIELDS;
module.exports.LIFECYCLE_CONTROLLED_FIELDS = LIFECYCLE_CONTROLLED_FIELDS;
module.exports.STATUS = STATUS;
