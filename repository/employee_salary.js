const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");

/**
 * M2 — the salary history table.
 *
 * THERE IS NO DELETE METHOD ON THIS CLASS, AND THAT IS THE DESIGN. The
 * approved rule is "no salary delete": a salary history that can be deleted is
 * not a history, and the audit value of the table comes entirely from rows
 * that cannot quietly disappear. A rejected revision stays on the record AS a
 * rejected revision. A test asserts that no method here issues a DELETE or a
 * TRUNCATE, so adding one later is a deliberate act that fails a test first.
 *
 * NO `SELECT *`. Every column is named, following the precedent
 * `repository/employee_work_shift.js` sets. Salary is the most sensitive data
 * in the system; a star select is how a column added in a later phase reaches
 * a screen nobody re-reviewed.
 *
 * THIS LAYER COMPUTES NOTHING. Every amount it writes was calculated by
 * `utils/salary_engine.js` and handed down by the usecase. The repository's
 * only job is storage, and the only rules it enforces are the ones the
 * database can enforce better than code - which is why the one-live-revision
 * rule is a unique index rather than a check-then-insert here.
 */

/** Every column the API ever returns, in one place. */
const SALARY_COLUMNS = [
  "salary_id",
  "employee_id",
  "monthly_gross",
  "daily_salary",
  "basic",
  "conveyance",
  "hra",
  "special_allowance",
  "manual_override",
  "override_reason",
  "pf_status",
  "pf_wage",
  "employee_pf",
  "employer_pf_total",
  "employer_epf",
  "employer_eps",
  "edli",
  "pf_admin_charge",
  "esi_status",
  "esi_wage",
  "employee_esi",
  "employer_esi",
  "monthly_ctc",
  "ctc_status",
  "unresolved_notes",
  "statutory_snapshot",
  "statutory_config_version",
  "effective_from",
  "status",
  "source",
  "created_by",
  "created_at",
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "rejection_reason",
  "updated_at",
];

const SELECT_LIST = SALARY_COLUMNS.map((c) => `s.\`${c}\``).join(", ");

const STATUS = { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED" };

class EmployeeSalaryRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_SALARY",
      code: `REPOSITORY.EMPLOYEE_SALARY.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * The statutory context the engine needs about ONE employee.
   *
   * FIVE COLUMNS AND A NAME. Not `SELECT *`, and deliberately not the bank
   * account, the Aadhaar, the PAN or the legacy `salary` - calculating
   * somebody's provident fund is not a reason to read their identity
   * documents. This is the whole of what the engine is entitled to see.
   *
   * `date_of_joining` GOES THROUGH THE SHARED PARSER. That column is a VARCHAR
   * holding three different shapes, and `utils/joining_date.js` is the one
   * rule for reading it - the same expression the C1b lifecycle backfill used.
   * Parsing it a second way here would let M2 and the lifecycle disagree about
   * when somebody joined, which would move the opening salary's effective
   * date. `dob` is a real DATE and is formatted so it arrives as a plain
   * `YYYY-MM-DD` string rather than a timezone-sensitive Date.
   */
  getStatutoryContext(employeeId) {
    const sql = `
      SELECT ne.\`employee_id\`,
             ne.\`employee_name\`,
             ne.\`status\`,
             ne.\`pf_applicable\`,
             ne.\`esi_applicable\`,
             ne.\`previous_pf_member\`,
             DATE_FORMAT(ne.\`dob\`, '%Y-%m-%d') AS \`dob\`,
             DATE_FORMAT(${JOINED_ON("ne")}, '%Y-%m-%d') AS \`date_of_joining\`
        FROM \`new_employee\` ne
       WHERE ne.\`employee_id\` = ?`;
    return this._query("GET-STATUTORY-CONTEXT", sql, [employeeId]).then(
      (rows) => (rows && rows[0]) || null
    );
  }

  /**
   * The CURRENT salary as at a date.
   *
   * The whole resolver rule in one query: the latest APPROVED record whose
   * effective date is on or before the as-of date.
   *
   *   PENDING is never current - it has not been agreed
   *   REJECTED is never current - it was refused
   *   a FUTURE approved record is not current until its effective date
   *
   * Ordered by `effective_from` and then `salary_id`, so two rows that somehow
   * share a date still resolve deterministically to the later one rather than
   * to whatever the storage engine returns first.
   */
  getCurrentSalary(employeeId, asOfDate) {
    const sql = `
      SELECT ${SELECT_LIST}
        FROM \`employee_salary\` s
       WHERE s.\`employee_id\` = ?
         AND s.\`status\` = ?
         AND s.\`effective_from\` <= ?
       ORDER BY s.\`effective_from\` DESC, s.\`salary_id\` DESC
       LIMIT 1`;
    return this._query("GET-CURRENT", sql, [employeeId, STATUS.APPROVED, asOfDate]).then(
      (rows) => (rows && rows[0]) || null
    );
  }

  /** Every revision for an employee, newest effective date first. */
  getHistory(employeeId) {
    const sql = `
      SELECT ${SELECT_LIST}
        FROM \`employee_salary\` s
       WHERE s.\`employee_id\` = ?
       ORDER BY s.\`effective_from\` DESC, s.\`salary_id\` DESC`;
    return this._query("GET-HISTORY", sql, [employeeId]);
  }

  /** One revision by its id. */
  getById(salaryId) {
    const sql = `SELECT ${SELECT_LIST} FROM \`employee_salary\` s WHERE s.\`salary_id\` = ?`;
    return this._query("GET-BY-ID", sql, [salaryId]).then((rows) => (rows && rows[0]) || null);
  }

  /**
   * True when the employee has a salary record that still counts - used to
   * tell an OPENING record from a revision.
   *
   * REJECTED ROWS DO NOT COUNT. If the only proposal ever made for somebody
   * was refused, they still have no salary, so the next attempt is still their
   * FIRST one: it takes the opening effective date (the later of the floor and
   * their date of joining) and the OPENING_SALARY source. Counting a rejected
   * row here would make the second attempt a "revision" of a salary that never
   * existed, and would demand an effective date the caller has no basis to
   * choose.
   */
  hasLiveSalary(employeeId) {
    const sql = "SELECT 1 FROM `employee_salary` WHERE `employee_id` = ? AND `status` <> ? LIMIT 1";
    return this._query("HAS-LIVE", sql, [employeeId, STATUS.REJECTED]).then(
      (rows) => (rows || []).length > 0
    );
  }

  /**
   * The non-rejected revision already sitting at an effective date, if any.
   *
   * The unique index is what actually guarantees there is at most one; this
   * exists so the usecase can answer with a clear message instead of handing
   * back a duplicate-key error.
   */
  getActiveRevisionAt(employeeId, effectiveFrom) {
    const sql = `
      SELECT ${SELECT_LIST}
        FROM \`employee_salary\` s
       WHERE s.\`employee_id\` = ?
         AND s.\`effective_from\` = ?
         AND s.\`status\` <> ?
       LIMIT 1`;
    return this._query("GET-ACTIVE-AT", sql, [employeeId, effectiveFrom, STATUS.REJECTED]).then(
      (rows) => (rows && rows[0]) || null
    );
  }

  /**
   * Non-rejected revisions dated AFTER a date.
   *
   * Future-conflict detection. Inserting a revision behind an existing future
   * one is legitimate but changes which record is current on which day, so the
   * usecase surfaces the conflict rather than letting it be discovered by a
   * payslip.
   */
  getFutureRevisions(employeeId, afterDate) {
    const sql = `
      SELECT ${SELECT_LIST}
        FROM \`employee_salary\` s
       WHERE s.\`employee_id\` = ?
         AND s.\`effective_from\` > ?
         AND s.\`status\` <> ?
       ORDER BY s.\`effective_from\` ASC`;
    return this._query("GET-FUTURE", sql, [employeeId, afterDate, STATUS.REJECTED]);
  }

  /** Insert one revision. Returns its new id. */
  create(row) {
    const sql = "INSERT INTO `employee_salary` SET ?";
    return this._query("CREATE", sql, [row]).then((result) => result.insertId);
  }

  /**
   * Amend a PENDING revision.
   *
   * SCOPED TO PENDING IN THE SQL ITSELF, not only in the usecase. Approved
   * history is immutable, and an immutability rule that lives only in a
   * service is one bug away from not existing - so the WHERE clause carries it
   * too. A caller that tries to amend an approved row updates nothing and is
   * told so by the affected-row count.
   */
  updatePending(salaryId, patch) {
    const sql = "UPDATE `employee_salary` SET ? WHERE `salary_id` = ? AND `status` = ?";
    return this._query("UPDATE-PENDING", sql, [patch, salaryId, STATUS.PENDING]).then(
      (result) => result.affectedRows
    );
  }

  /**
   * Approve a PENDING revision.
   *
   * Also scoped to PENDING in the SQL: approving twice, or approving something
   * already rejected, changes nothing rather than rewriting an audit trail.
   */
  approve(salaryId, approvedBy) {
    const sql = `
      UPDATE \`employee_salary\`
         SET \`status\` = ?, \`approved_by\` = ?, \`approved_at\` = CURRENT_TIMESTAMP
       WHERE \`salary_id\` = ? AND \`status\` = ?`;
    return this._query("APPROVE", sql, [STATUS.APPROVED, approvedBy, salaryId, STATUS.PENDING]).then(
      (result) => result.affectedRows
    );
  }

  /** Reject a PENDING revision, with a required reason. */
  reject(salaryId, rejectedBy, reason) {
    const sql = `
      UPDATE \`employee_salary\`
         SET \`status\` = ?, \`rejected_by\` = ?, \`rejected_at\` = CURRENT_TIMESTAMP,
             \`rejection_reason\` = ?
       WHERE \`salary_id\` = ? AND \`status\` = ?`;
    return this._query("REJECT", sql, [
      STATUS.REJECTED,
      rejectedBy,
      reason,
      salaryId,
      STATUS.PENDING,
    ]).then((result) => result.affectedRows);
  }
}

module.exports = (db) => new EmployeeSalaryRepository(db);
module.exports.EmployeeSalaryRepository = EmployeeSalaryRepository;
module.exports.SALARY_COLUMNS = SALARY_COLUMNS;
module.exports.STATUS = STATUS;
