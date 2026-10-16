const logger = require("../utils/logger");

/**
 * FULL & FINAL SETTLEMENT, EXIT INTERVIEW AND REHIRE ELIGIBILITY - the SQL.
 *
 * ================================================= THE EXIT CASE ==========
 *
 * `employee_fnf_settlement` holds ONE ROW PER EXIT EVENT - (employee, last
 * working day) is unique - and everything else hangs off it: the settlement
 * completion, the exit interview and the rehire assessments. A rejoin opens a
 * new employment period and the NEXT resignation carries a different date, so
 * it is a different case; nothing about an earlier exit is ever overwritten.
 *
 * `ensureCase` is the only way a case is created, and it is idempotent under
 * concurrency: INSERT ... ON DUPLICATE KEY UPDATE on the unique key returns
 * the existing row's id to the second of two simultaneous callers.
 *
 * ================================================ LOCK ORDER ==============
 *
 * Every writer here that touches payroll takes locks in the order Approve and
 * the payroll lifecycle already use: `payrun_period` (shared), then the
 * `payrun_employee_calculation` row FOR UPDATE, then this feature's rows. One
 * order everywhere is what keeps two writers from deadlocking each other.
 *
 * ============================================ CONFIDENTIALITY ============
 *
 * Interview answers and rehire assessments are read by their own methods and
 * NEVER joined into a payroll, payslip or Mini App read. No figure, interview
 * answer or assessment is logged - errors log a code and ids only.
 */
const getConnectionAsync = (db) =>
  new Promise((resolve, reject) =>
    db.getConnection((err, connection) => (err ? reject(err) : resolve(connection)))
  );
const beginAsync = (conn) =>
  new Promise((resolve, reject) => conn.beginTransaction((err) => (err ? reject(err) : resolve())));
const commitAsync = (conn) =>
  new Promise((resolve, reject) => conn.commit((err) => (err ? reject(err) : resolve())));
const rollbackAsync = (conn) => new Promise((resolve) => conn.rollback(() => resolve()));

/*
 * The case's own columns, for a JOIN beside another table's employee and exit
 * date. It deliberately does NOT re-select `employee_id` / `exit_date`: on a
 * LEFT JOIN with no case yet those are NULL and would overwrite the joined
 * table's values of the same name. `CASE_COLUMNS` adds them for reads of the
 * case table alone.
 */
/*
 * THE SETTLED AMOUNT IS NEVER STORED HERE. A settlement references the
 * published payroll document (`settled_payslip_id`) and the calculation it
 * was frozen from (`settled_calculation_hash`); the amount is read from that
 * document's frozen snapshot - the single source of truth - every time.
 * Published payslips are never deleted (Unpublish only archives them), so the
 * reference always resolves to exactly the document that was paid.
 */
const SETTLED_NET_FROM_PAYSLIP = (ref) =>
  `(SELECT JSON_UNQUOTE(JSON_EXTRACT(sp.snapshot_json, '$.final.net_pay')) FROM payrun_payslip sp WHERE sp.payslip_id = ${ref})`;
const CASE_JOIN_COLUMNS = `
  s.fnf_settlement_id, s.period_id,
  s.status AS settlement_status, s.payrun_employee_id AS settled_payrun_employee_id,
  s.period_year AS settled_period_year, s.period_month AS settled_period_month,
  s.settled_payslip_id, ${SETTLED_NET_FROM_PAYSLIP("s.settled_payslip_id")} AS settled_net_amount,
  s.payment_mode, s.payment_reference,
  DATE_FORMAT(s.paid_on, '%Y-%m-%d') AS paid_on, s.settled_by,
  DATE_FORMAT(s.settled_at, '%Y-%m-%d %H:%i:%s') AS settled_at`;
const CASE_COLUMNS = `s.employee_id, DATE_FORMAT(s.exit_date, '%Y-%m-%d') AS exit_date, ${CASE_JOIN_COLUMNS}`;

class EmployeeExitRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_EXIT",
      code: `REPOSITORY.EMPLOYEE_EXIT.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _read(code, sql, params, conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, rows) => {
        if (err) {
          if (err.code !== "ER_DUP_ENTRY") this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /** `fn(conn)` in one transaction on one pooled connection; rolled back on any error. */
  async withTransaction(fn) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginAsync(conn);
      const result = await fn(conn);
      await commitAsync(conn);
      return result;
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /* ========================================================= exit cases */

  /** The closed employment period this exit ended, when the lifecycle data has it. */
  async findClosedPeriod(employeeId, exitDate, conn = null) {
    const rows = await this._read(
      "FIND-CLOSED-PERIOD",
      `SELECT period_id FROM employee_employment_period
        WHERE employee_id = ? AND period_state = 'closed' AND ended_on = ?
        ORDER BY period_no DESC LIMIT 1`,
      [employeeId, exitDate],
      conn
    );
    return rows.length ? Number(rows[0].period_id) : null;
  }

  /**
   * THE CASE FOR ONE EXIT, created if it does not exist yet. Idempotent and
   * safe under concurrency (see the file header). Returns its id.
   */
  async ensureCase({ employee_id, exit_date, actor = null }, conn = null) {
    const periodId = await this.findClosedPeriod(employee_id, exit_date, conn);
    const res = await this._read(
      "ENSURE-CASE",
      `INSERT INTO employee_fnf_settlement (employee_id, exit_date, period_id, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         period_id = COALESCE(period_id, VALUES(period_id)),
         fnf_settlement_id = LAST_INSERT_ID(fnf_settlement_id)`,
      [employee_id, exit_date, periodId, actor],
      conn
    );
    return Number(res.insertId);
  }

  async getCase(caseId, conn = null, { forUpdate = false } = {}) {
    const rows = await this._read(
      "GET-CASE",
      `SELECT ${CASE_COLUMNS} FROM employee_fnf_settlement s WHERE s.fnf_settlement_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [caseId],
      conn
    );
    return rows.length ? rows[0] : null;
  }

  /**
   * EVERY EXIT OF ONE EMPLOYEE, newest first: the recorded cases, and every
   * closed employment period with a known end that has no case yet (so an
   * exit can be interviewed before payroll ever reaches it).
   */
  async listEmployeeExits(employeeId) {
    const cases = await this._read(
      "LIST-EMPLOYEE-CASES",
      `SELECT ${CASE_COLUMNS},
              (SELECT COUNT(*) FROM employee_exit_interview i WHERE i.fnf_settlement_id = s.fnf_settlement_id) AS has_interview
         FROM employee_fnf_settlement s
        WHERE s.employee_id = ?
        ORDER BY s.exit_date DESC`,
      [employeeId]
    );
    let periods = [];
    try {
      periods = await this._read(
        "LIST-EMPLOYEE-CLOSED-PERIODS",
        `SELECT period_id, period_no, DATE_FORMAT(joined_on, '%Y-%m-%d') AS joined_on,
                DATE_FORMAT(ended_on, '%Y-%m-%d') AS ended_on, end_reason_type
           FROM employee_employment_period
          WHERE employee_id = ? AND period_state = 'closed'
          ORDER BY period_no DESC`,
        [employeeId]
      );
    } catch (err) {
      if (!err || err.code !== "ER_NO_SUCH_TABLE") throw err;
    }
    return { cases, periods };
  }

  /* ============================================ the month's exits (F&F) */

  /**
   * THE EXIT MONTH'S PAYROLL ROWS: every initialized employee whose snapshot
   * last working day falls in the month, with their stored calculation
   * status, the ACTIVE payslip and the settlement case for that exit.
   */
  async listMonthPayrunExits({ year, month, from, to, store_ids = null, employee_ids = null }) {
    const params = [from, to, year, month];
    let clause = "";
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return [];
      clause += " AND pe.store_id IN (?)";
      params.push(store_ids);
    }
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause += " AND pe.employee_id IN (?)";
      params.push(employee_ids);
    }
    return this._read(
      "LIST-MONTH-PAYRUN-EXITS",
      `SELECT pe.payrun_employee_id, pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
              pe.designation_name, pe.pay_type,
              DATE_FORMAT(pe.date_of_joining, '%Y-%m-%d') AS date_of_joining,
              DATE_FORMAT(pe.resignation_date, '%Y-%m-%d') AS exit_date,
              c.payrun_calculation_id, c.status AS calc_stored_status,
              DATE_FORMAT(c.published_at, '%Y-%m-%d %H:%i:%s') AS published_at,
              c.net_pay, c.calculation_hash,
              p.payslip_id, p.document_type,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS live_exit_date,
              ${CASE_JOIN_COLUMNS}
         FROM payrun_employee pe
         LEFT JOIN new_employee ne ON ne.employee_id = pe.employee_id
         LEFT JOIN payrun_employee_calculation c
           ON c.period_year = pe.period_year AND c.period_month = pe.period_month AND c.employee_id = pe.employee_id
         LEFT JOIN payrun_payslip p
           ON p.payrun_employee_id = pe.payrun_employee_id AND p.status = 'ACTIVE'
         LEFT JOIN employee_fnf_settlement s
           ON s.employee_id = pe.employee_id AND s.exit_date = pe.resignation_date
        WHERE pe.resignation_date BETWEEN ? AND ?
          AND pe.period_year = ? AND pe.period_month = ?${clause}
        ORDER BY pe.resignation_date, pe.employee_id`,
      params
    );
  }

  /**
   * EXITS IN THE MONTH THAT PAYROLL HAS NOT REACHED AS AN EXIT: closed
   * employment periods that ended in the month, for employees with no payrun
   * row carrying THAT exit date - either no payrun row at all, or one
   * initialized before the resignation was recorded (`initialized_without_exit`).
   * The second kind is reported, never silently dropped: its snapshot has no
   * last working day, so the month would publish an ordinary payslip.
   */
  async listMonthUninitializedExits({ year, month, from, to, store_ids = null }) {
    const params = [year, month, from, to, year, month];
    let clause = "";
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return [];
      clause += " AND ne.store_id IN (?)";
      params.push(store_ids);
    }
    try {
      return await this._read(
        "LIST-MONTH-UNINITIALIZED-EXITS",
        `SELECT ep.employee_id, ne.employee_name, ne.store_id,
                DATE_FORMAT(ep.ended_on, '%Y-%m-%d') AS exit_date,
                EXISTS (SELECT 1 FROM payrun_employee pe2
                         WHERE pe2.employee_id = ep.employee_id
                           AND pe2.period_year = ? AND pe2.period_month = ?) AS initialized_without_exit,
                ${CASE_JOIN_COLUMNS}
           FROM employee_employment_period ep
           JOIN new_employee ne ON ne.employee_id = ep.employee_id
           LEFT JOIN employee_fnf_settlement s
             ON s.employee_id = ep.employee_id AND s.exit_date = ep.ended_on
          WHERE ep.period_state = 'closed' AND ep.ended_on BETWEEN ? AND ?
            AND NOT EXISTS (SELECT 1 FROM payrun_employee pe
                             WHERE pe.employee_id = ep.employee_id
                               AND pe.period_year = ? AND pe.period_month = ?
                               AND pe.resignation_date = ep.ended_on)${clause}
          ORDER BY ep.ended_on, ep.employee_id`,
        params
      );
    } catch (err) {
      if (err && err.code === "ER_NO_SUCH_TABLE") return [];
      throw err;
    }
  }

  /** Like `_read`, but a table that does not exist yet reads as no rows. */
  async _readTolerant(code, sql, params, conn = null) {
    try {
      return await new Promise((resolve, reject) =>
        (conn || this.db).query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
      );
    } catch (err) {
      if (err && err.code === "ER_NO_SUCH_TABLE") return [];
      this._log(code, err);
      throw err;
    }
  }

  /** One employee's payrun row for the month, inside the caller's branch scope. */
  async getPayrunRow({ year, month, employee_id, store_ids = null }) {
    const params = [year, month, employee_id];
    let clause = "";
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return null;
      clause = " AND pe.store_id IN (?)";
      params.push(store_ids);
    }
    const rows = await this._read(
      "GET-PAYRUN-ROW",
      `SELECT pe.payrun_employee_id, pe.employee_id, pe.employee_name,
              DATE_FORMAT(pe.resignation_date, '%Y-%m-%d') AS snapshot_exit_date,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS live_exit_date
         FROM payrun_employee pe
         LEFT JOIN new_employee ne ON ne.employee_id = pe.employee_id
        WHERE pe.period_year = ? AND pe.period_month = ? AND pe.employee_id = ?${clause}`,
      params
    );
    return rows.length ? rows[0] : null;
  }

  /** Approved OT still PENDING_SETTLEMENT up to this month, per employee (counts). */
  async listOutstandingOt(employeeIds, year, month) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._readTolerant(
      "LIST-OUTSTANDING-OT",
      `SELECT employee_id, COUNT(*) AS items, SUM(approved_ot_minutes) AS minutes, SUM(amount) AS amount
         FROM attendance_ot_late_settlement
        WHERE employee_id IN (?) AND settlement_status = 'PENDING_SETTLEMENT'
          AND (source_year * 12 + source_month) <= (? * 12 + ?)
        GROUP BY employee_id`,
      [employeeIds, year, month]
    );
  }

  /**
   * OT REQUESTS STILL AWAITING A DECISION up to each leaver's last working
   * day - the same predicate Settle refuses on. `exits` is
   * [{ employee_id, exit_date }].
   */
  async listOpenOtRequests(exits) {
    const list = (exits || []).filter((e) => e && e.employee_id && e.exit_date);
    if (list.length === 0) return [];
    const where = list.map(() => "(r.requested_for_employee_id = ? AND r.attendance_date <= ?)").join(" OR ");
    return this._readTolerant(
      "LIST-OPEN-OT-REQUESTS",
      `SELECT r.requested_for_employee_id AS employee_id, COUNT(*) AS n
         FROM attendance_approval_request r
        WHERE r.request_type IN ('OT','REGULARIZATION_WITH_OT')
          AND (r.status = 'PENDING' OR r.finalization_state = 'PENDING')
          AND (${where})
        GROUP BY r.requested_for_employee_id`,
      list.flatMap((e) => [e.employee_id, e.exit_date])
    );
  }

  /* ===================================================== exit reconcile */

  /**
   * RECONCILE A LATE-RECORDED EXIT INTO THE MONTH'S SNAPSHOT.
   *
   * The payrun snapshot's `resignation_date` is set to the employee master's
   * current one - the ONLY write - with an audit row, in one transaction.
   *
   * IT NEVER TOUCHES FIGURES. It refuses whenever the month holds a
   * calculation of any kind (the user resets it first with the existing,
   * audited Reset, which also releases any prior-month OT it had claimed);
   * an approved or published month must be unpublished / unlocked first with
   * the existing lifecycle actions. A locked payroll month refuses. An exit
   * date BEFORE the month means the employee was not employed in it at all,
   * which this action does not decide.
   */
  async reconcileExit({ year, month, from, to, employee_id, actor = {} }) {
    return this.withTransaction(async (conn) => {
      const [periodRow] = await this._read(
        "RECONCILE-LOCK-PERIOD",
        "SELECT status FROM payrun_period WHERE period_year = ? AND period_month = ? LOCK IN SHARE MODE",
        [year, month],
        conn
      );
      if (periodRow && periodRow.status === "LOCKED") return { outcome: "MONTH_LOCKED" };
      const [calcRow] = await this._read(
        "RECONCILE-LOCK-CALCULATION",
        `SELECT status, published_at FROM payrun_employee_calculation
          WHERE period_year = ? AND period_month = ? AND employee_id = ? FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (calcRow && calcRow.status === "APPROVED_LOCKED") {
        return { outcome: calcRow.published_at ? "PUBLISHED" : "APPROVED_LOCKED" };
      }
      if (calcRow) return { outcome: "CALCULATED" };
      const [payrun] = await this._read(
        "RECONCILE-LOCK-PAYRUN",
        `SELECT payrun_employee_id, DATE_FORMAT(resignation_date, '%Y-%m-%d') AS resignation_date
           FROM payrun_employee WHERE period_year = ? AND period_month = ? AND employee_id = ? FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (!payrun) return { outcome: "NOT_INITIALIZED" };
      const [live] = await this._read(
        "RECONCILE-READ-MASTER",
        `SELECT DATE_FORMAT(resignation_date, '%Y-%m-%d') AS resignation_date
           FROM new_employee WHERE employee_id = ? LOCK IN SHARE MODE`,
        [employee_id],
        conn
      );
      const liveExit = live ? live.resignation_date || null : null;
      const snapshotExit = payrun.resignation_date || null;
      if (liveExit === snapshotExit) return { outcome: "NOTHING_TO_RECONCILE" };
      if (liveExit && liveExit < from) return { outcome: "EXIT_BEFORE_MONTH", live_exit_date: liveExit };
      // An exit AFTER this month is not this month's: the snapshot keeps none.
      const next = liveExit && liveExit <= to ? liveExit : null;
      if (next === snapshotExit) return { outcome: "NOTHING_TO_RECONCILE" };
      const res = await this._read(
        "RECONCILE-UPDATE",
        `UPDATE payrun_employee SET resignation_date = ?
          WHERE payrun_employee_id = ? AND (resignation_date <=> ?)`,
        [next, payrun.payrun_employee_id, snapshotExit],
        conn
      );
      if (Number(res.affectedRows) !== 1) throw new Error("RECONCILE moved no row; rolled back");
      await this._read(
        "RECONCILE-AUDIT",
        `INSERT INTO payrun_exit_reconcile_audit
                (payrun_employee_id, period_year, period_month, employee_id,
                 old_resignation_date, new_resignation_date, actor_employee_id, actor_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [payrun.payrun_employee_id, year, month, employee_id, snapshotExit, next, actor.employeeId ?? null, actor.userId ?? null],
        conn
      );
      return { outcome: "RECONCILED", old_exit_date: snapshotExit, new_exit_date: next };
    });
  }

  /* ================================================ settlement completion */

  /**
   * MARK AN F&F AS SETTLED - once.
   *
   * Under the calculation row's lock (the payroll lifecycle's own), the month
   * must still be Approved & Locked AND published, its ACTIVE document must be
   * an F&F statement, and the case must not already be SETTLED. What was
   * settled is frozen on the case: the payslip, the calculation hash and the
   * Net Pay. `uq_fnf_payrun` refuses one payroll month settling two exits.
   * A second Settle - a double click, two tabs - finds SETTLED and changes
   * nothing.
   */
  async settle({ year, month, employee_id, payment_mode, payment_reference = null, paid_on, actor = {} }) {
    return this.withTransaction(async (conn) => {
      const [calcRow] = await this._read(
        "SETTLE-LOCK-CALCULATION",
        `SELECT c.payrun_calculation_id, c.payrun_employee_id, c.status, c.published_at, c.calculation_hash,
                DATE_FORMAT(pe.resignation_date, '%Y-%m-%d') AS exit_date
           FROM payrun_employee_calculation c
           JOIN payrun_employee pe ON pe.payrun_employee_id = c.payrun_employee_id
          WHERE c.period_year = ? AND c.period_month = ? AND c.employee_id = ?
          FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (!calcRow) return { outcome: "NOT_CALCULATED" };
      if (calcRow.status !== "APPROVED_LOCKED" || !calcRow.published_at) return { outcome: "NOT_PUBLISHED" };
      const [slip] = await this._read(
        "SETTLE-READ-PAYSLIP",
        `SELECT payslip_id, document_type, calculation_hash FROM payrun_payslip
          WHERE payrun_employee_id = ? AND status = 'ACTIVE' FOR UPDATE`,
        [calcRow.payrun_employee_id],
        conn
      );
      if (!slip) return { outcome: "NOT_PUBLISHED" };
      if (slip.document_type !== "FNF") return { outcome: "NOT_FNF" };
      if (String(slip.calculation_hash) !== String(calcRow.calculation_hash)) return { outcome: "CALCULATION_CHANGED" };
      /*
       * APPROVED OT STILL WAITING FOR A MONTH. The F&F month is the leaver's
       * last; an approved OT item still PENDING_SETTLEMENT up to it would
       * never be paid once this settlement closes. Refused until the month is
       * unlocked and recalculated (which claims the item into the F&F).
       */
      const pendingOt = await this._readTolerant(
        "SETTLE-OUTSTANDING-OT",
        `SELECT COUNT(*) AS n FROM attendance_ot_late_settlement
          WHERE employee_id = ? AND settlement_status = 'PENDING_SETTLEMENT'
            AND (source_year * 12 + source_month) <= (? * 12 + ?)`,
        [employee_id, year, month],
        conn
      );
      if (pendingOt.length && Number(pendingOt[0].n) > 0) return { outcome: "OUTSTANDING_OT" };
      // ...and no OT request up to the last working day may still be undecided.
      const [openOt] = await this._read(
        "SETTLE-OPEN-OT-REQUESTS",
        `SELECT COUNT(*) AS n FROM attendance_approval_request
          WHERE requested_for_employee_id = ? AND request_type IN ('OT','REGULARIZATION_WITH_OT')
            AND attendance_date <= ? AND (status = 'PENDING' OR finalization_state = 'PENDING')`,
        [employee_id, calcRow.exit_date],
        conn
      );
      if (openOt && Number(openOt.n) > 0) return { outcome: "OUTSTANDING_OT" };

      const caseId = await this.ensureCase({ employee_id, exit_date: calcRow.exit_date, actor: actor.employeeId ?? null }, conn);
      const existing = await this.getCase(caseId, conn, { forUpdate: true });
      if (existing.settlement_status === "SETTLED") return { outcome: "ALREADY_SETTLED", case: existing };

      const res = await this._read(
        "SETTLE-UPDATE",
        `UPDATE employee_fnf_settlement
            SET status = 'SETTLED', payrun_employee_id = ?, period_year = ?, period_month = ?,
                settled_payslip_id = ?, settled_calculation_hash = ?,
                payment_mode = ?, payment_reference = ?, paid_on = ?,
                settled_by = ?, settled_at = CURRENT_TIMESTAMP
          WHERE fnf_settlement_id = ? AND status = 'PENDING'`,
        [
          calcRow.payrun_employee_id, year, month,
          slip.payslip_id, calcRow.calculation_hash,
          payment_mode, payment_reference, paid_on,
          actor.employeeId ?? null, caseId,
        ],
        conn
      );
      if (Number(res.affectedRows) !== 1) throw new Error(`SETTLE moved ${res.affectedRows} rows for case ${caseId}; rolled back`);
      await this._read(
        "SETTLE-EVENT",
        `INSERT INTO employee_fnf_settlement_event
                (fnf_settlement_id, event_type, payrun_employee_id, payslip_id, calculation_hash,
                 payment_mode, payment_reference, paid_on, actor_employee_id, actor_user_id)
         VALUES (?, 'SETTLED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          caseId, calcRow.payrun_employee_id, slip.payslip_id, calcRow.calculation_hash,
          payment_mode, payment_reference, paid_on, actor.employeeId ?? null, actor.userId ?? null,
        ],
        conn
      );
      return { outcome: "SETTLED", case: await this.getCase(caseId, conn) };
    });
  }

  /**
   * REOPEN A SETTLED F&F - the one way back, with a reason. The settled
   * figures stay on the event history; the case returns to PENDING so the
   * payroll month may be unpublished / unlocked and corrected.
   */
  async reopen({ year, month, employee_id, reason, actor = {} }) {
    return this.withTransaction(async (conn) => {
      const [calcRow] = await this._read(
        "REOPEN-LOCK-CALCULATION",
        `SELECT payrun_employee_id FROM payrun_employee_calculation
          WHERE period_year = ? AND period_month = ? AND employee_id = ? FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (!calcRow) return { outcome: "NOT_SETTLED" };
      const [row] = await this._read(
        "REOPEN-LOCK-CASE",
        `SELECT fnf_settlement_id, status, settled_payslip_id, settled_calculation_hash
           FROM employee_fnf_settlement WHERE payrun_employee_id = ? FOR UPDATE`,
        [calcRow.payrun_employee_id],
        conn
      );
      if (!row || row.status !== "SETTLED") return { outcome: "NOT_SETTLED" };
      await this._read(
        "REOPEN-UPDATE",
        `UPDATE employee_fnf_settlement
            SET status = 'PENDING', payrun_employee_id = NULL, period_year = NULL, period_month = NULL,
                settled_payslip_id = NULL, settled_calculation_hash = NULL,
                payment_mode = NULL, payment_reference = NULL, paid_on = NULL,
                settled_by = NULL, settled_at = NULL
          WHERE fnf_settlement_id = ? AND status = 'SETTLED'`,
        [row.fnf_settlement_id],
        conn
      );
      await this._read(
        "REOPEN-EVENT",
        `INSERT INTO employee_fnf_settlement_event
                (fnf_settlement_id, event_type, payrun_employee_id, payslip_id, calculation_hash,
                 reason, actor_employee_id, actor_user_id)
         VALUES (?, 'REOPENED', ?, ?, ?, ?, ?, ?)`,
        [
          row.fnf_settlement_id, calcRow.payrun_employee_id, row.settled_payslip_id,
          row.settled_calculation_hash, reason, actor.employeeId ?? null, actor.userId ?? null,
        ],
        conn
      );
      return { outcome: "REOPENED", case: await this.getCase(row.fnf_settlement_id, conn) };
    });
  }

  async listSettlementEvents(caseId) {
    return this._read(
      "LIST-SETTLEMENT-EVENTS",
      `SELECT event_type, payslip_id, ${SETTLED_NET_FROM_PAYSLIP("employee_fnf_settlement_event.payslip_id")} AS net_amount,
              payment_mode, payment_reference,
              DATE_FORMAT(paid_on, '%Y-%m-%d') AS paid_on, reason, actor_employee_id,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM employee_fnf_settlement_event
        WHERE fnf_settlement_id = ?
        ORDER BY fnf_settlement_event_id DESC`,
      [caseId]
    );
  }

  /* ===================================================== exit interview */

  async getInterview(caseId) {
    const rows = await this._read(
      "GET-INTERVIEW",
      `SELECT exit_interview_id, fnf_settlement_id, employee_id,
              DATE_FORMAT(interview_date, '%Y-%m-%d') AS interview_date, primary_reason,
              rating_job_satisfaction, rating_manager_support, rating_work_environment, rating_compensation,
              would_recommend, would_return, feedback, suggestions, revision,
              recorded_by, DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at,
              updated_by, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
         FROM employee_exit_interview WHERE fnf_settlement_id = ?`,
      [caseId]
    );
    return rows.length ? rows[0] : null;
  }

  /** One interview per case: the first save inserts, a later one updates and bumps the revision. */
  async saveInterview(caseId, employeeId, fields, actor = null) {
    const cols = Object.keys(fields);
    await this._read(
      "SAVE-INTERVIEW",
      `INSERT INTO employee_exit_interview
              (fnf_settlement_id, employee_id, ${cols.map((c) => `\`${c}\``).join(", ")}, recorded_by, updated_by)
       VALUES (?, ?, ${cols.map(() => "?").join(", ")}, ?, ?)
       ON DUPLICATE KEY UPDATE
         ${cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ")},
         updated_by = VALUES(updated_by), revision = revision + 1`,
      [caseId, employeeId, ...cols.map((c) => fields[c]), actor, actor]
    );
    return this.getInterview(caseId);
  }

  /* ============================================== rehire eligibility */

  async listRehire(caseId) {
    return this._read(
      "LIST-REHIRE",
      `SELECT rehire_assessment_id, eligibility, conditions, note, is_override, override_reason,
              assessed_by, DATE_FORMAT(assessed_at, '%Y-%m-%d %H:%i:%s') AS assessed_at
         FROM employee_rehire_assessment
        WHERE fnf_settlement_id = ?
        ORDER BY rehire_assessment_id DESC`,
      [caseId]
    );
  }

  /**
   * APPEND an assessment. The case row is locked FOR UPDATE so two people
   * assessing the same exit at once serialize, and `expectFirst` (the caller
   * believed there was none yet) is re-checked under that lock: a second
   * "first" assessment is refused as an override nobody authorized.
   */
  async addRehire(caseId, employeeId, { eligibility, conditions, note, override_reason, expectFirst }, actor = {}) {
    return this.withTransaction(async (conn) => {
      await this.getCase(caseId, conn, { forUpdate: true });
      const [prior] = await this._read(
        "REHIRE-COUNT",
        "SELECT COUNT(*) AS n FROM employee_rehire_assessment WHERE fnf_settlement_id = ?",
        [caseId],
        conn
      );
      const isOverride = Number(prior.n) > 0;
      if (expectFirst && isOverride) return { outcome: "ALREADY_ASSESSED" };
      await this._read(
        "REHIRE-INSERT",
        `INSERT INTO employee_rehire_assessment
                (fnf_settlement_id, employee_id, eligibility, conditions, note, is_override, override_reason,
                 assessed_by, assessed_by_user)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          caseId, employeeId, eligibility, conditions, note, isOverride ? 1 : 0,
          isOverride ? override_reason : null, actor.employeeId ?? null, actor.userId ?? null,
        ],
        conn
      );
      return { outcome: isOverride ? "OVERRIDDEN" : "ASSESSED" };
    });
  }

  /**
   * THE NEWEST REHIRE ASSESSMENT OF ONE EXIT, read on the REJOIN's own
   * transaction connection (`tx.query`), so the gate decides on committed
   * data under the rejoin's employee lock. No assessment table (migration not
   * run) reads as no assessment.
   */
  async rehireForExitTx(tx, employeeId, exitDate) {
    if (!exitDate) return null;
    try {
      const rows = await tx.query(
        `SELECT r.rehire_assessment_id, r.eligibility, r.conditions, s.fnf_settlement_id
           FROM employee_fnf_settlement s
           JOIN employee_rehire_assessment r ON r.fnf_settlement_id = s.fnf_settlement_id
          WHERE s.employee_id = ? AND s.exit_date = ?
          ORDER BY r.rehire_assessment_id DESC
          LIMIT 1`,
        [employeeId, exitDate]
      );
      return rows && rows[0] ? rows[0] : null;
    } catch (err) {
      if (err && err.code === "ER_NO_SUCH_TABLE") return null;
      throw err;
    }
  }

  /** The audit row of an approved rehire exception, in the rejoin's transaction. */
  async recordRehireExceptionTx(tx, row) {
    await tx.query(
      `INSERT INTO employee_rehire_exception
              (fnf_settlement_id, rehire_assessment_id, employee_id, eligibility, conditions,
               reason, rejoin_date, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.fnf_settlement_id, row.rehire_assessment_id, row.employee_id, row.eligibility,
        row.conditions || null, row.reason, row.rejoin_date, row.approved_by ?? null,
      ]
    );
  }

  async listRehireExceptions(employeeId) {
    return this._readTolerant(
      "LIST-REHIRE-EXCEPTIONS",
      `SELECT eligibility, conditions, reason, DATE_FORMAT(rejoin_date, '%Y-%m-%d') AS rejoin_date,
              approved_by, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM employee_rehire_exception WHERE employee_id = ? ORDER BY employee_rehire_exception_id DESC`,
      [employeeId]
    );
  }

  /** The newest assessment of the employee's most recent assessed exit, or null. */
  /**
   * IS AN EXIT RECORDED FOR THIS EMPLOYEE IN THE EMPLOYEE LIFECYCLE? The
   * Resign action sets `new_employee.resignation_date` and closes the
   * employment period; only Rejoin (which applies the rehire assessment)
   * clears / reopens them. Read by the legacy resignation delete, which must
   * not reactivate such an employee behind Rejoin's back.
   */
  async lifecycleExitOf(employeeId) {
    const rows = await this._read(
      "LIFECYCLE-EXIT-OF",
      `SELECT DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date,
              (SELECT ep.period_state FROM employee_employment_period ep
                WHERE ep.employee_id = ne.employee_id
                ORDER BY ep.period_no DESC LIMIT 1) AS latest_period_state
         FROM new_employee ne
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows.length ? rows[0] : null;
  }

  async latestRehireForEmployee(employeeId) {
    const rows = await this._read(
      "LATEST-REHIRE",
      `SELECT r.eligibility, r.conditions, DATE_FORMAT(s.exit_date, '%Y-%m-%d') AS exit_date,
              DATE_FORMAT(r.assessed_at, '%Y-%m-%d %H:%i:%s') AS assessed_at
         FROM employee_rehire_assessment r
         JOIN employee_fnf_settlement s ON s.fnf_settlement_id = r.fnf_settlement_id
        WHERE r.employee_id = ?
        ORDER BY s.exit_date DESC, r.rehire_assessment_id DESC
        LIMIT 1`,
      [employeeId]
    );
    return rows.length ? rows[0] : null;
  }
}

module.exports = (db) => new EmployeeExitRepository(db);
module.exports.EmployeeExitRepository = EmployeeExitRepository;
