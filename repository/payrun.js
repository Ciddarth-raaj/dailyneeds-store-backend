const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");
const {
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * Payrun Initialization - the reads a payroll month needs, and the one write
 * that takes a snapshot.
 *
 * EVERY READ IS BATCHED ACROSS THE WHOLE MONTH'S POPULATION, for the reason
 * `repository/attendance_dashboard.js` states about itself: a screen covering
 * six hundred employees cannot afford a per-employee query, and the
 * per-employee repositories that already exist are built for one person's
 * month. Each statement below takes the month - and, where it needs one, an
 * employee-id list - and comes back once.
 *
 * IT CALCULATES NOTHING. There is no attendance arithmetic, no salary
 * arithmetic and no eligibility rule in this file. It READS what the
 * attendance engine and the salary lifecycle already stored, and
 * `utils/payrun_eligibility.js` - which is pure - decides what it means.
 *
 * IT NEVER WRITES OUTSIDE ITS OWN THREE TABLES. There is no UPDATE of
 * `new_employee` here, and in particular none of `new_employee.payment_type`:
 * a payrun pay type is a fact about ONE month and writing it back to the
 * master is precisely the silent mutation this feature exists to avoid. There
 * is no write of `employee_salary` or of any attendance table either.
 *
 * EVERY DATE LEAVES AS A STRING, through DATE_FORMAT, exactly as the
 * attendance repositories do it: the API pool has no `dateStrings` option, so
 * a bare DATE comes back as a JS Date built in the process timezone and a
 * payroll month is one of the places an off-by-one day is most expensive.
 */

/**
 * THE LOCATION PREDICATE, with the same fail-CLOSED behaviour
 * `repository/attendance_dashboard.js` documents at length:
 *
 *   null   no restriction - the caller is authorized company-wide
 *   [1,2]  exactly these locations
 *   []     NO locations at all, expressed as `1 = 0` in SQL
 *
 * An empty authorized set is the ordinary result of asking for a branch you may
 * not see, so it must return nothing rather than falling through to no clause
 * at all and returning everything.
 */
function locationPredicate(column, store_ids) {
  if (store_ids === null || store_ids === undefined) return { clause: null, params: [] };
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return { clause: "1 = 0", params: [] };
  }
  return { clause: `${column} IN (?)`, params: [store_ids] };
}

class PayrunRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.PAYRUN",
      code: `REPOSITORY.PAYRUN.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _read(code, sql, params, conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ------------------------------------------------------------ the month */

  /**
   * The month's own state. NO ROW MEANS OPEN - see the migration; a month
   * nobody has ever acted on has no row, and treating that as anything but
   * open would lock every month that has not yet been touched.
   */
  async getPeriod(year, month) {
    const rows = await this._read(
      "GET-PERIOD",
      `SELECT payrun_period_id, period_year, period_month, status,
              DATE_FORMAT(locked_at, '%Y-%m-%d %H:%i:%s') AS locked_at, locked_by
         FROM payrun_period
        WHERE period_year = ? AND period_month = ?`,
      [year, month]
    );
    return rows[0] || null;
  }

  /* ------------------------------------------------------- the population */

  /**
   * EVERYBODY WHOSE MONTH THIS COULD BE - the payroll population, before any
   * eligibility rule is applied.
   *
   * EMPLOYMENT IS THE DATED FACT, NOT `status`, and this is the same predicate
   * `repository/attendance_dashboard.js#listApplicableEmployees` settled on,
   * for the reason recorded there: `new_employee.status` is maintained by hand
   * and has been left at 1 for most leavers, so reading it alone would put
   * people who left years ago into this month's payroll. Somebody who left
   * BEFORE the month starts, or who joins AFTER it ends, is not in the month.
   *
   * AN UNREADABLE JOINING DATE INCLUDES THE EMPLOYEE rather than dropping
   * them: most production rows have no readable joining date, and a payroll
   * screen that silently omitted them would be worse than one that shows them
   * and lets the eligibility rules speak.
   *
   * `status` IS NOT SELECTED AT ALL. It was, for a resigned pay-type default
   * that no longer exists, and nothing else ever read it: membership of the
   * month is decided by the dated facts above, and the pay type is decided by
   * the Employee Master's `payment_type` and by nothing else. A column nobody
   * reads is a column somebody eventually writes a rule against, so it is
   * simply not loaded.
   *
   * THE COLUMNS ARE NAMED AND MINIMAL. No Aadhaar, no PAN, no photograph. The
   * bank pair is read only to report the payment-readiness WARNING, and the
   * account number never leaves this layer - the usecase turns it into a
   * boolean (see `usecase/payrun.js`).
   */
  async listPopulation({ year, month, store_ids = null, designation_id = null }) {
    const pad = (n) => String(n).padStart(2, "0");
    const from = `${year}-${pad(month)}-01`;
    const to = `${year}-${pad(month)}-${pad(new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate())}`;

    const where = [
      "(ne.resignation_date IS NULL OR ne.resignation_date >= ?)",
      `((${JOINED_ON("ne")}) IS NULL OR (${JOINED_ON("ne")}) <= ?)`,
    ];
    const params = [from, to];

    const location = locationPredicate("ne.store_id", store_ids);
    if (location.clause) {
      where.push(location.clause);
      params.push(...location.params);
    }
    if (designation_id !== null && designation_id !== undefined && designation_id !== "") {
      where.push("ne.designation_id = ?");
      params.push(designation_id);
    }

    return this._read(
      "LIST-POPULATION",
      `SELECT ne.employee_id,
              ne.employee_name,
              ne.store_id,
              o.outlet_name AS store_name,
              ne.designation_id,
              d.designation_name,
              ne.department_id,
              ne.payment_type,
              ne.pf_applicable,
              ne.esi_applicable,
              ne.uan,
              ne.pf_number,
              ne.esi_number,
              ne.account_no,
              ne.ifsc,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS date_of_joining
         FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
        WHERE ${where.join(" AND ")}
        ORDER BY ne.employee_id`,
      params
    );
  }

  /**
   * THE APPROVED SALARY EACH EMPLOYEE IS ON FOR THIS MONTH, in one statement.
   *
   * THE RESOLVER IS M2'S AND IS NOT REIMPLEMENTED - the latest APPROVED row
   * effective on or before the as-of date, which is exactly what
   * `repository/employee_salary.js#getCurrentSalary` answers for one employee
   * and what `repository/attendance_calculation.js#getMonthlyGrossAsOf` reads
   * for one month. PENDING is never current and REJECTED is never current.
   *
   * AS OF THE LAST DAY OF THE MONTH, the same choice the attendance monthly
   * roll-up already made and states: a revision effective mid-month is a
   * question this stage does not answer, so the month is priced on one rate.
   *
   * ONE ROW PER EMPLOYEE, chosen by a correlated MAX rather than by reading
   * every revision and picking in JS - six hundred employees with a dozen
   * revisions each is eight thousand rows to throw away.
   */
  async listApprovedSalaries(employeeIds, asOfDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-APPROVED-SALARIES",
      `SELECT s.salary_id, s.employee_id, s.monthly_gross, s.daily_salary,
              s.basic, s.conveyance, s.hra, s.special_allowance,
              DATE_FORMAT(s.effective_from, '%Y-%m-%d') AS effective_from
         FROM employee_salary s
         JOIN (
              SELECT employee_id, MAX(effective_from) AS effective_from
                FROM employee_salary
               WHERE employee_id IN (?)
                 AND status = 'APPROVED'
                 AND effective_from <= ?
               GROUP BY employee_id
         ) latest
           ON latest.employee_id = s.employee_id
          AND latest.effective_from = s.effective_from
        WHERE s.status = 'APPROVED'
        ORDER BY s.employee_id, s.salary_id DESC`,
      [employeeIds, asOfDate]
    );
  }

  /**
   * THE STORED ATTENDANCE MONTH, as the attendance engine left it.
   *
   * PAYROLL CONSUMES; IT DOES NOT CALCULATE. This reads
   * `attendance_monthly_payroll` - the row `calculateMonth(..., persist)`
   * writes - and takes from it only what the payrun needs: the reference, the
   * version markers, and `is_final`, which is false exactly when the engine
   * held dates out of the month because their punch list is known to be
   * incomplete. No minute, day count or amount is recomputed anywhere in this
   * feature.
   */
  async listAttendanceMonths(employeeIds, year, month) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-ATTENDANCE-MONTHS",
      `SELECT attendance_monthly_payroll_id, employee_id, is_final, payroll_version,
              held_dates,
              DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS calculated_at
         FROM attendance_monthly_payroll
        WHERE employee_id IN (?) AND period_year = ? AND period_month = ?`,
      [employeeIds, year, month]
    );
  }

  /**
   * UNRESOLVED ATTENDANCE WORK FOR DATES INSIDE THE MONTH, counted per
   * employee and split into the two things it can be.
   *
   * WHY BOTH HALVES COME FROM ONE STATEMENT. They are rows of one table
   * distinguished by `request_type`, and asking twice would mean two reads
   * that can disagree about a request raised between them.
   *
   * WHAT COUNTS AS UNRESOLVED, and it is deliberately two conditions:
   *
   *   status = 'PENDING'            nobody has decided it yet
   *   finalization_state = 'PENDING' it was approved, but the OT half is not
   *                                 settled - and only SETTLED OT is
   *                                 payroll-effective (see the A3 notes in
   *                                 `usecase/attendance_calculation.js`)
   *
   * A REGULARIZATION_WITH_OT COUNTS AS BOTH, because it is both: the punch is
   * unresolved and so is the overtime that hangs off it.
   */
  async listPendingApprovals(employeeIds, from, to) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-PENDING-APPROVALS",
      `SELECT r.requested_for_employee_id AS employee_id,
              SUM(CASE WHEN r.request_type IN ('REGULARIZATION','REGULARIZATION_WITH_OT')
                       THEN 1 ELSE 0 END) AS pending_regularizations,
              SUM(CASE WHEN r.request_type IN ('OT','REGULARIZATION_WITH_OT')
                       THEN 1 ELSE 0 END) AS pending_ot
         FROM attendance_approval_request r
        WHERE r.requested_for_employee_id IN (?)
          AND r.attendance_date >= ? AND r.attendance_date <= ?
          AND (r.status = 'PENDING' OR r.finalization_state = 'PENDING')
        GROUP BY r.requested_for_employee_id`,
      [employeeIds, from, to]
    );
  }

  /** The snapshots that already exist for this month. */
  async listPayrunRows({ year, month, employee_ids = null }, conn = null) {
    const params = [year, month];
    let clause = "period_year = ? AND period_month = ?";
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause += " AND employee_id IN (?)";
      params.push(employee_ids);
    }
    return this._read(
      "LIST-PAYRUN-ROWS",
      `SELECT payrun_employee_id, period_year, period_month, employee_id,
              employee_name, store_id, store_name, designation_id, designation_name,
              department_id,
              DATE_FORMAT(date_of_joining, '%Y-%m-%d')  AS date_of_joining,
              DATE_FORMAT(resignation_date, '%Y-%m-%d') AS resignation_date,
              salary_id,
              DATE_FORMAT(salary_effective_from, '%Y-%m-%d') AS salary_effective_from,
              monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
              pf_applicable, esi_applicable, uan, pf_number, esi_number,
              attendance_monthly_payroll_id, attendance_payroll_version,
              DATE_FORMAT(attendance_calculated_at, '%Y-%m-%d %H:%i:%s') AS attendance_calculated_at,
              pay_type, pay_type_source, status,
              DATE_FORMAT(initialized_at, '%Y-%m-%d %H:%i:%s') AS initialized_at,
              initialized_by
         FROM payrun_employee
        WHERE ${clause}
        ORDER BY employee_id`,
      params,
      conn
    );
  }

  /* ------------------------------------------------------------- the write */

  /**
   * TAKE THE SNAPSHOTS, ALL OF THEM OR NONE OF THEM.
   *
   * ONE TRANSACTION FOR THE WHOLE BULK, and `INSERT IGNORE` inside it, and the
   * two together are what make initialization idempotent AND transaction-safe
   * at once:
   *
   *   the UNIQUE KEY on (year, month, employee) is what actually prevents a
   *   duplicate - not a SELECT-then-INSERT in the application, which is a race
   *   with a comment on it
   *
   *   IGNORE turns a row that lost that race into a row that did nothing,
   *   rather than into an error that rolls back nineteen good snapshots
   *   because a twentieth was initialized by somebody else a moment ago
   *
   * WHAT THE CALLER GETS BACK is which employee ids now have a row, read back
   * inside the same transaction. That is the honest answer for both cases: a
   * row this call inserted and a row that already existed are both "this
   * employee's month is initialized", and the usecase tells them apart by what
   * it knew before it started.
   *
   * A ROW THAT THE CALLER NEVER SENT CANNOT BE WRITTEN. Every value below is
   * taken from `rows`, which the usecase builds from the SERVER's own reads -
   * never from a request body. See `usecase/payrun.js`.
   */
  async insertSnapshots(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);

      const columns = [
        "period_year", "period_month", "employee_id", "employee_name",
        "store_id", "store_name", "designation_id", "designation_name", "department_id",
        "date_of_joining", "resignation_date",
        "salary_id", "salary_effective_from", "monthly_gross", "daily_salary",
        "basic", "conveyance", "hra", "special_allowance",
        "pf_applicable", "esi_applicable", "uan", "pf_number", "esi_number",
        "attendance_monthly_payroll_id", "attendance_payroll_version",
        "attendance_calculated_at",
        "pay_type", "pay_type_source", "status", "initialized_by",
      ];
      const values = rows.map((row) => columns.map((c) => (row[c] === undefined ? null : row[c])));

      await this._read(
        "INSERT-SNAPSHOTS",
        `INSERT IGNORE INTO payrun_employee (${columns.map((c) => `\`${c}\``).join(", ")})
         VALUES ?`,
        [values],
        conn
      );

      const written = await this._read(
        "READ-BACK-SNAPSHOTS",
        `SELECT employee_id, payrun_employee_id, pay_type, pay_type_source
           FROM payrun_employee
          WHERE period_year = ? AND period_month = ? AND employee_id IN (?)`,
        [rows[0].period_year, rows[0].period_month, rows.map((r) => r.employee_id)],
        conn
      );

      await commitAsync(conn);
      return written;
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * CHANGE ONE MONTH'S PAY TYPE, AND RECORD THAT IT WAS CHANGED.
   *
   * THE UPDATE AND ITS AUDIT ROW MOVE TOGETHER, in one transaction, for the
   * same reason `repository/attendance_regularization.js` puts a decision and
   * its consequence in one: a pay type that changed with no audit row is a
   * change nobody can account for, and an audit row for a change that did not
   * happen is worse.
   *
   * THE OLD VALUE IS READ UNDER `FOR UPDATE`, so two people flipping the same
   * row at once produce two audit rows in a defensible order rather than two
   * rows both claiming the same previous value.
   *
   * IT UPDATES `payrun_employee` AND NOTHING ELSE. There is deliberately no
   * statement here that touches `new_employee`.
   *
   * @returns {null} when the month has no snapshot for this employee
   */
  async changePayType({ year, month, employee_id, pay_type, changed_by }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);

      const current = await this._read(
        "LOCK-PAYRUN-ROW",
        `SELECT payrun_employee_id, pay_type
           FROM payrun_employee
          WHERE period_year = ? AND period_month = ? AND employee_id = ?
          FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (!current[0]) {
        await commitAsync(conn);
        return null;
      }

      const row = current[0];
      if (row.pay_type === pay_type) {
        // NOTHING CHANGED, SO NOTHING IS AUDITED. An audit row saying Cash
        // became Cash is noise in the one log somebody will read when they are
        // trying to find out who changed something.
        await commitAsync(conn);
        return { payrun_employee_id: row.payrun_employee_id, old_pay_type: row.pay_type, new_pay_type: pay_type, changed: false };
      }

      await this._read(
        "UPDATE-PAY-TYPE",
        `UPDATE payrun_employee
            SET pay_type = ?, pay_type_source = 'MANUAL'
          WHERE payrun_employee_id = ?`,
        [pay_type, row.payrun_employee_id],
        conn
      );

      await this._read(
        "INSERT-PAY-TYPE-AUDIT",
        `INSERT INTO payrun_employee_pay_type_audit
                (payrun_employee_id, period_year, period_month, employee_id,
                 old_pay_type, new_pay_type, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.payrun_employee_id, year, month, employee_id, row.pay_type, pay_type, changed_by],
        conn
      );

      await commitAsync(conn);
      return {
        payrun_employee_id: row.payrun_employee_id,
        old_pay_type: row.pay_type,
        new_pay_type: pay_type,
        changed: true,
      };
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /** The pay type history for one employee's month, newest first. */
  async listPayTypeAudit({ year, month, employee_id }) {
    return this._read(
      "LIST-PAY-TYPE-AUDIT",
      `SELECT payrun_pay_type_audit_id, old_pay_type, new_pay_type, changed_by,
              DATE_FORMAT(changed_at, '%Y-%m-%d %H:%i:%s') AS changed_at
         FROM payrun_employee_pay_type_audit
        WHERE period_year = ? AND period_month = ? AND employee_id = ?
        ORDER BY payrun_pay_type_audit_id DESC`,
      [year, month, employee_id]
    );
  }
}

module.exports = (db) => new PayrunRepository(db);
module.exports.PayrunRepository = PayrunRepository;
module.exports.locationPredicate = locationPredicate;
