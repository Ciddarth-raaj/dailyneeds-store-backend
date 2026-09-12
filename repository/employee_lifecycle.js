const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");

/**
 * Stage 0C / C1c — the SQL half of the employment-lifecycle reconciler.
 *
 * Every statement here is about `employee_employment_period` and
 * `employee_lifecycle_event`. Nothing in this file writes to `new_employee`:
 * C1c only records what the employee master already says about who is
 * employed and when. That master is dnds.co.in itself since Stage 0C / C2 -
 * the Digisme sync that used to own it has been removed
 * (docs/digisme-employee-sync-removal.md) - so the reconciler reads local
 * HR's Create / Edit / Resign / Rejoin rather than a vendor payload.
 *
 * Locking. Two reconciliations running at once would otherwise both read
 * "latest period is closed, employee is active" and both insert a rejoin
 * period. There is one caller today and it is manual, but the lock is not
 * conditional on that and must not be removed on those grounds. Reconciling
 * one employee therefore begins by taking a row lock on that employee's
 * `new_employee` row. The row always exists - the periods table has an FK to
 * it - so it can be locked even when the employee has no period yet, which a
 * lock on the periods table could not do. The `uq_one_open_period` unique
 * index stays the final net underneath.
 */

const PERIOD_COLUMNS = `
  p.period_id, p.employee_id, p.period_no, p.period_state,
  p.joined_on, p.ended_on, p.end_reason_type, p.source, p.needs_review`;

/* --------------------------------------------------------- pool plumbing --
 * The app hands repositories a mysql pool. A transaction must run on ONE
 * connection, so it is checked out explicitly and always released.
 */
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

class EmployeeLifecycleRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_LIFECYCLE",
      code: `REPOSITORY.EMPLOYEE_LIFECYCLE.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  /**
   * Runs `fn(tx)` inside one transaction on one pooled connection. `tx` is a
   * thin object exposing `query`; the caller never sees the raw connection
   * and so cannot leak it. Rolls back and rethrows on any error, and
   * releases the connection either way.
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

  /** `lc_time_names` must be en_US or the long-form date rule returns NULL for every row. */
  async assertDateLocale(tx) {
    const rows = await tx.query("SELECT @@lc_time_names AS l", []);
    const locale = rows && rows[0] ? String(rows[0].l) : null;
    if (locale !== "en_US") {
      throw new Error(
        `lc_time_names is '${locale}', not 'en_US'; STR_TO_DATE(..., '%d %M %Y') would return NULL ` +
          `for every long-form joining date. Refusing to reconcile.`
      );
    }
  }

  /**
   * Takes the per-employee lock and returns the master's current state with
   * the joining date already parsed by the shared rule. Returns null when the
   * employee does not exist.
   */
  async lockAndReadEmployee(tx, employeeId) {
    const rows = await tx.query(
      `SELECT ne.employee_id,
              ne.status,
              ne.resignation_date,
              ne.date_of_joining AS raw_date_of_joining,
              (${JOINED_ON("ne")}) AS parsed_joined_on
         FROM new_employee ne
        WHERE ne.employee_id = ?
        FOR UPDATE`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * The employee's newest period - the open one, or the most recent closed
   * one - carrying the end date of the period BEFORE it.
   *
   * `prev_ended_on` is what makes a later joining date judgeable. On a second
   * or third period, a date read from `new_employee.date_of_joining` is only
   * credible if it postdates the previous spell; without the previous end
   * there is nothing to judge it against, and the reconciler leaves the date
   * NULL rather than guess.
   */
  async getLatestPeriod(tx, employeeId) {
    const rows = await tx.query(
      `SELECT ${PERIOD_COLUMNS},
              ( SELECT prev.ended_on
                  FROM employee_employment_period prev
                 WHERE prev.employee_id = p.employee_id
                   AND prev.period_no < p.period_no
                 ORDER BY prev.period_no DESC
                 LIMIT 1 ) AS prev_ended_on
         FROM employee_employment_period p
        WHERE p.employee_id = ?
        ORDER BY p.period_no DESC
        LIMIT 1`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async insertPeriod(tx, period) {
    const res = await tx.query(
      `INSERT INTO employee_employment_period
         (employee_id, period_no, period_state, joined_on, ended_on,
          end_reason_type, source, needs_review, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?)`,
      [
        period.employee_id,
        period.period_no,
        period.period_state,
        period.joined_on,
        period.ended_on,
        period.end_reason_type,
        period.needs_review ? 1 : 0,
        period.actor_employee_id === undefined ? null : period.actor_employee_id,
        period.actor_employee_id === undefined ? null : period.actor_employee_id,
      ]
    );
    return res.insertId;
  }

  /**
   * Closes an open period. Guarded by `period_state = 'open'` in the WHERE so
   * a second concurrent closure affects zero rows rather than re-closing with
   * different values; the caller checks affectedRows.
   */
  async closePeriod(tx, periodId, { ended_on, end_reason_type, needs_review, actor_employee_id }) {
    const res = await tx.query(
      `UPDATE employee_employment_period
          SET period_state = 'closed',
              ended_on = ?,
              end_reason_type = ?,
              needs_review = ?,
              updated_by = ?
        WHERE period_id = ? AND period_state = 'open'`,
      [
        ended_on,
        end_reason_type,
        needs_review ? 1 : 0,
        actor_employee_id === undefined ? null : actor_employee_id,
        periodId,
      ]
    );
    return res.affectedRows;
  }

  /**
   * Fills a date that is currently NULL, and never one that is not. The
   * `IS NULL` predicate is in the WHERE rather than checked in JavaScript, so
   * a concurrent writer cannot slip a known date in between the read and the
   * write and have it overwritten here.
   */
  async fillNullDate(tx, periodId, column, value, { needs_review, actor_employee_id }) {
    if (column !== "joined_on" && column !== "ended_on") {
      throw new Error(`fillNullDate refuses column '${column}'`);
    }
    const res = await tx.query(
      `UPDATE employee_employment_period
          SET \`${column}\` = ?, needs_review = ?, updated_by = ?
        WHERE period_id = ? AND \`${column}\` IS NULL`,
      [
        value,
        needs_review ? 1 : 0,
        actor_employee_id === undefined ? null : actor_employee_id,
        periodId,
      ]
    );
    return res.affectedRows;
  }

  /**
   * Overwrites a period's `joined_on`, known or not. Unlike `fillNullDate`
   * this IS allowed to replace a recorded date: it exists for HR's audited
   * joining-date correction, which records the old and new value on the
   * event it writes in the same transaction. Nothing automatic calls it.
   */
  async setJoinedOn(tx, periodId, value, { needs_review, actor_employee_id }) {
    const res = await tx.query(
      `UPDATE employee_employment_period
          SET joined_on = ?, needs_review = ?, updated_by = ?
        WHERE period_id = ?`,
      [value, needs_review ? 1 : 0, actor_employee_id === undefined ? null : actor_employee_id, periodId]
    );
    return res.affectedRows;
  }

  async insertEvent(tx, event) {
    const res = await tx.query(
      `INSERT INTO employee_lifecycle_event
         (employee_id, period_id, event_type, actor_employee_id, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        event.employee_id,
        event.period_id === undefined ? null : event.period_id,
        event.event_type,
        event.actor_employee_id === undefined ? null : event.actor_employee_id,
        // A JSON column needs a string: the driver would otherwise expand a
        // plain object into `key = value` pairs.
        event.detail === undefined || event.detail === null
          ? null
          : JSON.stringify(event.detail),
      ]
    );
    return res.insertId;
  }

  /**
   * Employee ids whose master state and newest period disagree, plus those
   * with no period at all. In a steady state this returns nothing, which is
   * what makes a nightly sync cost one query rather than 630 transactions.
   */
  async listEmployeesNeedingReconciliation(limit) {
    const sql = `
      SELECT ne.employee_id
        FROM new_employee ne
        LEFT JOIN (
          SELECT p.employee_id, p.period_no, p.period_state, p.joined_on, p.ended_on
            FROM employee_employment_period p
            JOIN ( SELECT employee_id, MAX(period_no) AS period_no
                     FROM employee_employment_period GROUP BY employee_id ) latest
              ON latest.employee_id = p.employee_id AND latest.period_no = p.period_no
        ) cur ON cur.employee_id = ne.employee_id
       WHERE cur.employee_id IS NULL                                        -- no period yet
          OR (cur.period_state = 'open'   AND ne.status <> 1)               -- became inactive
          OR (cur.period_state = 'closed' AND ne.status = 1)                -- rejoined
          -- A joining date now readable for a FIRST period. Later periods are
          -- excluded here on purpose: the master holds one joining date and
          -- Digisme does not update it on a rejoin, so for period 2+ it is
          -- usually the original and the reconciler refuses it. Listing those
          -- would make every unresolved rejoin a permanent candidate that can
          -- never be settled.
          OR (cur.period_no = 1 AND cur.joined_on IS NULL
              AND (${JOINED_ON("ne")}) IS NOT NULL)
          OR (cur.period_state = 'closed' AND cur.ended_on IS NULL
              AND ne.resignation_date IS NOT NULL)                          -- end date now known
       ORDER BY ne.employee_id
       LIMIT ?`;
    return new Promise((resolve, reject) => {
      this.db.query(sql, [Number(limit)], (err, rows) => {
        if (err) {
          this._log("LIST-NEEDING-RECONCILIATION", err);
          reject(err);
          return;
        }
        resolve((rows || []).map((r) => r.employee_id));
      });
    });
  }
}

module.exports = (db) => new EmployeeLifecycleRepository(db);
module.exports.EmployeeLifecycleRepository = EmployeeLifecycleRepository;
