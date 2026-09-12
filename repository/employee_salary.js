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
  // M4. The proposer's business reason for a REVISION or a CORRECTION. NOT
  // `override_reason` (why the breakup departs from the automatic one) and NOT
  // `rejection_reason` (why an approver refused) - three different questions,
  // asked of three different people, kept in three columns.
  "revision_reason",
  "created_by",
  "created_at",
  // M4 review fix. WHO amended this proposal while it was PENDING, and WHEN -
  // a dedicated audit fact, because `updated_at` below also moves when a
  // proposal is approved or rejected and names nobody at all. NULL on both
  // means the proposal has never been amended.
  "changed_by",
  "changed_at",
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "rejection_reason",
  // The generic row-update timestamp, unchanged and NOT an amendment time.
  "updated_at",
];

const SELECT_LIST = SALARY_COLUMNS.map((c) => `s.\`${c}\``).join(", ");

/**
 * M4 — WHO did it, by name, resolved in the query that reads the row.
 *
 * `created_by`, `changed_by`, `approved_by` and `rejected_by` hold EMPLOYEE
 * ids. A salary history that names four numbers is not an audit trail anybody
 * can read, and
 * the alternative - letting a screen look each id up - is one request per
 * distinct actor per history, which is the N+1 the approved task rules out.
 *
 * The ids are kept ALONGSIDE the names rather than replaced by them: a name is
 * for reading and an id is what the record actually asserts, and an employee
 * row that has since been renamed must not silently change what an old
 * approval says. A LEFT JOIN, so a deleted or missing actor leaves a null name
 * beside a surviving id rather than dropping the whole revision from history.
 *
 * NOTHING BUT THE NAME COMES OVER. Not the outlet, not the designation and
 * certainly none of the B3 columns - reading who approved a revision is not a
 * reason to read their record.
 */
const ACTOR_NAME_SELECT = [
  "cb.`employee_name` AS `created_by_name`",
  "hb.`employee_name` AS `changed_by_name`",
  "ab.`employee_name` AS `approved_by_name`",
  "rb.`employee_name` AS `rejected_by_name`",
].join(", ");

const ACTOR_NAME_JOINS = `
        LEFT JOIN \`new_employee\` cb ON cb.\`employee_id\` = s.\`created_by\`
        LEFT JOIN \`new_employee\` hb ON hb.\`employee_id\` = s.\`changed_by\`
        LEFT JOIN \`new_employee\` ab ON ab.\`employee_id\` = s.\`approved_by\`
        LEFT JOIN \`new_employee\` rb ON rb.\`employee_id\` = s.\`rejected_by\``;

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
   * SIX COLUMNS AND A NAME. Not `SELECT *`, and deliberately not the bank
   * account, the Aadhaar, the PAN or the legacy `salary` - calculating
   * somebody's provident fund is not a reason to read their identity
   * documents. This is the whole of what the engine is entitled to see.
   *
   * BOTH MEMBERSHIP HISTORIES ARE READ, because they are two different facts.
   * `previous_eps_member` is the one the pension split turns on;
   * `previous_pf_member` is the EPF history beside it and no rule in the
   * engine infers one from the other.
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
             ne.\`previous_eps_member\`,
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

  /**
   * Every revision for an employee, newest effective date first.
   *
   * M4 ADDS THE FOUR ACTOR NAMES and nothing else - created, changed,
   * approved and rejected. The rows are the same
   * rows; the join is here rather than on the screen because a history of
   * twenty revisions would otherwise be twenty-odd employee reads from the
   * browser to render one table.
   */
  getHistory(employeeId) {
    const sql = `
      SELECT ${SELECT_LIST}, ${ACTOR_NAME_SELECT}
        FROM \`employee_salary\` s${ACTOR_NAME_JOINS}
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
   * M4 review fix — THE ONE PENDING PROPOSAL FOR AN EMPLOYEE, IF THERE IS ONE.
   *
   * The business rule is that a salary proposal is one decision at a time: an
   * employee may have AT MOST ONE PENDING proposal, whatever its effective
   * date. `uq_salary_pending_proposal` is what makes that true - a unique key
   * on (`employee_id`, `pending_proposal_marker`), where the generated marker
   * is 1 for a PENDING row and NULL for every decided one - and this read is
   * how the usecase answers with a sentence somebody can act on instead of
   * handing back a duplicate-key error.
   *
   * AN INDEXED READ, NOT A FILTERED HISTORY. `idx_salary_current`
   * (`employee_id`, `status`, `effective_from`) answers this directly. The
   * alternative - reading the whole history and filtering in JavaScript -
   * would pull every revision an employee has ever had across the wire to
   * answer a yes/no question, on every single create.
   *
   * `LIMIT 1` and an explicit ORDER BY, so that a database which somehow holds
   * two (one from before the unique key existed) still answers
   * deterministically rather than differently on each call.
   */
  getPendingForEmployee(employeeId) {
    const sql = `
      SELECT ${SELECT_LIST}
        FROM \`employee_salary\` s
       WHERE s.\`employee_id\` = ?
         AND s.\`status\` = ?
       ORDER BY s.\`effective_from\` ASC, s.\`salary_id\` ASC
       LIMIT 1`;
    return this._query("GET-PENDING-FOR-EMPLOYEE", sql, [employeeId, STATUS.PENDING]).then(
      (rows) => (rows && rows[0]) || null
    );
  }

  /** True when a PENDING proposal is outstanding for this employee. */
  hasPending(employeeId) {
    return this.getPendingForEmployee(employeeId).then((row) => row !== null);
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

  /**
   * M4 — EVERY PENDING PROPOSAL, ACROSS ALL EMPLOYEES: the approval queue.
   *
   * WHY THIS IS A QUERY AND NOT A LOOP. The alternative an approval screen
   * reaches for is "list the employees, then read each one's history and keep
   * the pending rows", which is six hundred requests to draw a list that is
   * usually four rows long, and which hands the browser five hundred and
   * ninety-six salary histories it had no business seeing. One indexed read on
   * `idx_salary_status` answers the same question.
   *
   * PENDING ONLY, IN THE SQL. Approved and rejected rows are not "filtered out"
   * of the result - they are never selected. An approval queue that could be
   * made to show an approved revision is one query-string away from offering a
   * second approval of something already decided.
   *
   * THE CURRENT APPROVED SALARY COMES BACK WITH THE PROPOSAL, because "is this
   * a rise, and by how much" is the question the queue exists to answer, and a
   * screen that had to fetch the current salary per row would be back to the
   * N+1 this method avoids. It is resolved by exactly the rule
   * `getCurrentSalary` uses - the latest APPROVED row effective on or before
   * the as-of date - through a single correlated lookup of its id, so the queue
   * and the resolver cannot drift apart.
   *
   * IT IS NAMED `current_monthly_gross`, NOT `salary` OR `current_salary`.
   * `middlewares/sensitive.js#filterResponse` strips keys called `salary` at
   * any depth, so that name would make the figure vanish for callers without
   * `view_employee_sensitive` - silently, with no error and no 403.
   *
   * THE EMPLOYEE COLUMNS ARE THE FOUR THE QUEUE SHOWS: id, name, outlet and
   * designation. Not the bank account, not the PAN, not the Aadhaar and not the
   * legacy `salary` column - deciding a pay revision is not a reason to read
   * somebody's identity documents, the same principle `getStatutoryContext`
   * already follows.
   *
   * FILTERS ARE ALL OPTIONAL AND ALL PARAMETERISED. An absent filter adds no
   * clause; nothing here is interpolated into the SQL.
   */
  getPendingQueue(filters = {}) {
    const where = ["s.`status` = ?"];
    const params = [STATUS.PENDING];

    if (filters.employee_id !== undefined && filters.employee_id !== null) {
      where.push("s.`employee_id` = ?");
      params.push(filters.employee_id);
    }
    if (filters.store_id !== undefined && filters.store_id !== null) {
      where.push("ne.`store_id` = ?");
      params.push(filters.store_id);
    }
    if (filters.effective_from) {
      where.push("s.`effective_from` >= ?");
      params.push(filters.effective_from);
    }
    if (filters.effective_to) {
      where.push("s.`effective_from` <= ?");
      params.push(filters.effective_to);
    }

    /*
     * The as-of date for "what is this person on TODAY" is the caller's, so the
     * queue reads the same current salary the Employee Master would show on the
     * same day, rather than one derived from the database server's clock.
     */
    const sql = `
      SELECT ${SELECT_LIST}, ${ACTOR_NAME_SELECT},
             ne.\`employee_name\`,
             ne.\`store_id\`,
             ne.\`designation_id\`,
             o.\`outlet_name\`,
             o.\`outlet_nickname\`,
             d.\`designation_name\`,
             cur.\`salary_id\`      AS \`current_salary_id\`,
             cur.\`monthly_gross\`  AS \`current_monthly_gross\`,
             cur.\`effective_from\` AS \`current_effective_from\`
        FROM \`employee_salary\` s${ACTOR_NAME_JOINS}
        JOIN \`new_employee\` ne ON ne.\`employee_id\` = s.\`employee_id\`
        LEFT JOIN \`outlets\` o     ON o.\`outlet_id\` = ne.\`store_id\`
        LEFT JOIN \`designation\` d ON d.\`designation_id\` = ne.\`designation_id\`
        LEFT JOIN \`employee_salary\` cur ON cur.\`salary_id\` = (
               SELECT c.\`salary_id\`
                 FROM \`employee_salary\` c
                WHERE c.\`employee_id\` = s.\`employee_id\`
                  AND c.\`status\` = ?
                  AND c.\`effective_from\` <= ?
                ORDER BY c.\`effective_from\` DESC, c.\`salary_id\` DESC
                LIMIT 1)
       WHERE ${where.join(" AND ")}
       ORDER BY s.\`effective_from\` ASC, s.\`salary_id\` ASC
       LIMIT ?`;

    // The two resolver parameters sit in the JOIN, which the parser reaches
    // before the WHERE clause - so they go in front of the filter values.
    const ordered = [STATUS.APPROVED, filters.as_of, ...params, filters.limit];
    return this._query("GET-PENDING-QUEUE", sql, ordered);
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
   *
   * M4 review fix — THE AMENDMENT AUDIT IS STAMPED HERE, BY THIS METHOD, AND
   * NOT BY ITS CALLER. This is the only path in the system that changes a
   * pending proposal, so `changed_by` and `changed_at` are written by the same
   * statement that makes the change: an amendment cannot be made without
   * recording who made it, because there is no code path that does one without
   * the other. They are deliberately absent from `approve` and `reject`, which
   * name the columns they set, so a decision never overwrites the record of an
   * amendment - or invents one that never happened.
   *
   * `CURRENT_TIMESTAMP`, the DATABASE's clock, exactly as `approved_at` and
   * `rejected_at` take theirs. Four audit times on one row taken from two
   * different clocks would not be orderable.
   *
   * The patch is the usecase's calculated row and NEVER carries these two
   * columns; they are stripped before it is bound, so a caller cannot dictate
   * its own amendment timestamp or name somebody else as the amender.
   */
  updatePending(salaryId, patch, changedBy = null) {
    const values = { ...patch };
    delete values.changed_by;
    delete values.changed_at;

    const sql =
      "UPDATE `employee_salary` SET ?, `changed_by` = ?, `changed_at` = CURRENT_TIMESTAMP" +
      " WHERE `salary_id` = ? AND `status` = ?";
    return this._query("UPDATE-PENDING", sql, [
      values,
      changedBy ?? null,
      salaryId,
      STATUS.PENDING,
    ]).then((result) => result.affectedRows);
  }

  /**
   * Approve a PENDING revision.
   *
   * Also scoped to PENDING in the SQL: approving twice, or approving something
   * already rejected, changes nothing rather than rewriting an audit trail.
   *
   * IT NAMES THE COLUMNS IT SETS, and `changed_by`/`changed_at` are not among
   * them. Approving a proposal is not amending it, so the record of who last
   * amended it - or the NULL saying nobody ever did - survives the decision.
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

  /**
   * Reject a PENDING revision, with a required reason.
   *
   * Like `approve`, it names the columns it sets and leaves `changed_by` and
   * `changed_at` exactly as they are.
   */
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
