const {
  PAY_TYPE,
  PAY_TYPES,
  PAY_TYPE_SOURCE,
  PAYRUN_STATUS,
  PERIOD_STATUS,
  STATUS_GROUP,
  LIFECYCLE_FILTER,
} = require("../constants/payrun");
const {
  monthWindow,
  evaluateEmployee,
  summarize,
} = require("../utils/payrun_eligibility");

/**
 * Payrun Initialization - Non-Initialized -> Initialize -> Calculated, and
 * this is the first arrow.
 *
 * WHAT INITIALIZATION MEANS, IN ONE SENTENCE: it takes the employee's working
 * payroll snapshot for a month from the approved salary and the calculated
 * attendance that are in force RIGHT NOW, and from then on the month is read
 * from that snapshot instead of from those sources.
 *
 * SO WHAT CHANGES AT THAT MOMENT IS WHO IS AUTHORITATIVE. Before: a salary
 * revision, a regularized punch or a corrected shift flows into the month
 * normally, because the month is only a view. After: the same change does not
 * touch the snapshot, and a later, explicit Recalculate - which is NOT built
 * here - is the only thing that refreshes it. A month that silently changed
 * under a payslip that had already been issued is the failure this design
 * exists to prevent.
 *
 * THE RULES ARE NOT IN THIS FILE. `utils/payrun_eligibility.js` is pure and
 * holds every decision about whether a month may be initialized and what pay
 * type it starts on; this file fetches what those rules need and performs what
 * they permit - the same division `usecase/attendance_calculation.js` keeps
 * with `utils/attendance_payroll.js`.
 *
 * NO ATTENDANCE IS CALCULATED HERE, and none is recalculated. The payrun READS
 * `attendance_monthly_payroll` - the row the attendance engine stores - and
 * refuses a month the engine has not settled. There is no punch, shift or
 * minute anywhere in this feature.
 *
 * NOTHING A CLIENT SENDS BECOMES A STORED VALUE, except the two things a
 * client is entitled to choose: WHICH employees to initialize and WHICH of the
 * two pay types to set. Every figure written into a snapshot - the gross, the
 * structure, the statutory flags, the attendance reference, the names and the
 * dates - is read by the server from the server's own tables inside the same
 * request. A body carrying a `monthly_gross` cannot change one: there is no
 * path from a request body to that column.
 */

/** Shaped so `utils/http.js#respondError` answers 400 with the detail. */
function validationError(message, extra = {}) {
  const err = new Error(message);
  err.name = "ValidationError";
  Object.assign(err, extra);
  return err;
}

/** An integer that is really an integer, whatever shape it arrived in. */
function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * THE MONTH, VALIDATED ONCE, HERE.
 *
 * Every entry point takes a year and a month and none of them may trust one:
 * a month of 13 would build a date range MySQL happily accepts and a snapshot
 * for a period that does not exist.
 */
function normalizeMonth(year, month) {
  const y = intOrNull(year);
  const m = intOrNull(month);
  if (y === null || m === null || m < 1 || m > 12 || y < 2000 || y > 2100) {
    throw validationError("year and month must be integers, month 1-12");
  }
  return { year: y, month: m };
}

/** One of the two pay types, or a refusal. Never HOLD; see `constants/payrun.js`. */
function normalizePayType(value) {
  const text = String(value === null || value === undefined ? "" : value).trim().toUpperCase();
  if (!PAY_TYPES.includes(text)) {
    throw validationError(`pay_type must be one of ${PAY_TYPES.join(", ")}`);
  }
  return text;
}

/** A clean, de-duplicated employee id list, or a refusal. */
function normalizeEmployeeIds(value) {
  const list = Array.isArray(value) ? value : [value];
  const ids = [];
  list.forEach((raw) => {
    const n = intOrNull(raw);
    if (n === null || n <= 0) throw validationError("employee_ids must be positive integers");
    if (!ids.includes(n)) ids.push(n);
  });
  if (ids.length === 0) throw validationError("employee_ids must not be empty");
  return ids;
}

/** Row-level outcome codes. Stable strings; the screen keys off them. */
const ROW_RESULT = {
  INITIALIZED: "INITIALIZED",
  ALREADY_INITIALIZED: "ALREADY_INITIALIZED",
  BLOCKED: "BLOCKED",
  NOT_IN_SCOPE: "NOT_IN_SCOPE",
};

class PayrunUsecase {
  /**
   * @param payrunRepo         this stage's three tables
   * @param calculationLocks   OPTIONAL, and one method: which employees'
   *                           months are approved and locked. A locked month's
   *                           pay type is part of what the approval committed
   *                           to, so changing it afterwards is refused - per
   *                           EMPLOYEE, never per month. The answer belongs to
   *                           the calculation stage, which is where approval
   *                           happens; reading its table from here would be a
   *                           second place that knows what locked means.
   *                           Absent means nobody is locked, which is the
   *                           truth before the calculation stage is wired.
   */
  constructor(payrunRepo, calculationLocks = null) {
    this.repo = payrunRepo;
    this.calculationLocks = calculationLocks;
  }

  /**
   * THE MONTH, ASSEMBLED: every employee it could concern, what is stopping
   * each of them, and which of them already have a snapshot.
   *
   * SIX READS FOR SIX HUNDRED EMPLOYEES, not six hundred reads. Every
   * statement behind this is batched across the population - see
   * `repository/payrun.js` - because a screen that costs one query per
   * employee is a screen that is opened once and then avoided.
   *
   * THE SCOPE IS THE SERVER'S. `store_ids` arrives already resolved by the
   * employee branch scope and is passed through untouched: `null` is
   * company-wide, a list is those branches, and an EMPTY list is no branches
   * at all rather than all of them.
   */
  async getMonth({
    year,
    month,
    store_ids = null,
    designation_id = null,
    status = null,
    lifecycle = null,
  }) {
    const period = normalizeMonth(year, month);
    const { from, to } = monthWindow(period.year, period.month);

    const [population, periodRow] = await Promise.all([
      this.repo.listPopulation({
        year: period.year,
        month: period.month,
        store_ids,
        designation_id,
      }),
      this.repo.getPeriod(period.year, period.month),
    ]);

    const monthLocked = Boolean(periodRow && periodRow.status === PERIOD_STATUS.LOCKED);
    const employeeIds = population.map((e) => e.employee_id);

    const [salaries, attendance, pending, existing] = await Promise.all([
      this.repo.listApprovedSalaries(employeeIds, to),
      this.repo.listAttendanceMonths(employeeIds, period.year, period.month),
      this.repo.listPendingApprovals(employeeIds, from, to),
      this.repo.listPayrunRows({ year: period.year, month: period.month, employee_ids: employeeIds }),
    ]);

    const byEmployee = (rows) => {
      const map = new Map();
      (rows || []).forEach((row) => {
        if (!map.has(row.employee_id)) map.set(row.employee_id, row);
      });
      return map;
    };
    const salaryOf = byEmployee(salaries);
    const attendanceOf = byEmployee(attendance);
    const pendingOf = byEmployee(pending);
    const existingOf = byEmployee(existing);

    const rows = population.map((employee) => {
      const salary = salaryOf.get(employee.employee_id) || null;
      const attendanceRow = attendanceOf.get(employee.employee_id) || null;
      const counts = pendingOf.get(employee.employee_id) || {};
      const snapshot = existingOf.get(employee.employee_id) || null;

      const verdict = evaluateEmployee({
        year: period.year,
        month: period.month,
        employee,
        salary,
        attendance: attendanceRow,
        pending_regularizations: Number(counts.pending_regularizations || 0),
        pending_ot: Number(counts.pending_ot || 0),
        month_locked: monthLocked,
        existing: snapshot,
      });

      /*
       * THE ACCOUNT NUMBER NEVER LEAVES THE SERVER. The repository reads the
       * bank pair only so that the missing-details WARNING can be raised; what
       * goes out is the warning, and the columns themselves are dropped here.
       * Reading a payroll month is not a reason to be told anybody's account
       * number, and `view_banks` is the key that would be.
       */
      return {
        employee_id: employee.employee_id,
        employee_name: employee.employee_name,
        store_id: employee.store_id,
        store_name: employee.store_name,
        designation_id: employee.designation_id,
        designation_name: employee.designation_name,
        date_of_joining: employee.date_of_joining,
        resignation_date: employee.resignation_date,
        monthly_gross:
          snapshot && snapshot.monthly_gross !== null && snapshot.monthly_gross !== undefined
            ? snapshot.monthly_gross
            : (salary ? salary.monthly_gross : null),
        salary_id: snapshot ? snapshot.salary_id : (salary ? salary.salary_id : null),
        salary_effective_from: snapshot
          ? snapshot.salary_effective_from
          : (salary ? salary.effective_from : null),
        status: verdict.status,
        blocking_reasons: verdict.blocking_reasons,
        warnings: verdict.warnings,
        pay_type: verdict.pay_type,
        pay_type_source: verdict.pay_type_source,
        /*
         * A BADGE, NOT A RULE. It says whether this employee had left by the
         * end of THIS month, so whoever works the month can see who may need
         * moving to CASH by hand. Nothing defaults from it - see
         * `defaultPayType`, which cannot receive an employment fact at all.
         */
        exited_in_month: verdict.exited_in_month,
        initialized: verdict.initialized,
        initialized_at: snapshot ? snapshot.initialized_at : null,
        initialized_by: snapshot ? snapshot.initialized_by : null,
        payrun_employee_id: snapshot ? snapshot.payrun_employee_id : null,
      };
    });

    /*
     * THE TWO FILTERS ARE INDEPENDENT, AND BOTH ARE APPLIED HERE - on the
     * server, after the month has been evaluated, which is where the status
     * filter has always been applied.
     *
     * WHY NOT IN SQL. `exited_in_month` is decided by ONE dated rule
     * (`exitedByMonthEnd`), and putting a resignation-date comparison into the
     * population query as well would be that rule written twice. Two copies of
     * a date comparison is exactly what produced the historical-payrun bug -
     * the badge and the filter would eventually disagree about who left when.
     * The population read is unchanged; the filtering happens against the
     * evaluated rows, so the filter and the badge can only ever agree.
     *
     * THEY COMPOSE. Status narrows by what the PAYRUN says; lifecycle narrows
     * by what the EMPLOYMENT RECORD says. "Exited + Blocked" is the leaver
     * whose month nobody can close; "Exited + Initialized" is the list whose
     * pay type may need moving to CASH by hand.
     */
    const wantedStatus =
      status && Object.values(STATUS_GROUP).includes(String(status).toUpperCase())
        ? String(status).toUpperCase()
        : null;

    const wantedLifecycle =
      lifecycle && Object.values(LIFECYCLE_FILTER).includes(String(lifecycle).toUpperCase())
        ? String(lifecycle).toUpperCase()
        : null;

    const filtered = rows.filter((row) => {
      if (wantedStatus && row.status !== wantedStatus) return false;
      if (wantedLifecycle === LIFECYCLE_FILTER.EXITED && row.exited_in_month !== true) return false;
      if (wantedLifecycle === LIFECYCLE_FILTER.ACTIVE && row.exited_in_month === true) return false;
      return true;
    });

    return {
      period_year: period.year,
      period_month: period.month,
      period_status: monthLocked ? PERIOD_STATUS.LOCKED : PERIOD_STATUS.OPEN,
      month_locked: monthLocked,
      // The summary counts the WHOLE month, never the filtered view: a status
      // filter is a way of looking at the month, not a different month.
      summary: summarize(rows),
      rows: filtered,
    };
  }

  /**
   * INITIALIZE - one employee or a hundred, by the same path.
   *
   * THERE IS NO SEPARATE SINGLE-EMPLOYEE ROUTE THROUGH THIS CODE. "Initialize"
   * on one row is a bulk of one, so the single and the bulk case cannot end up
   * applying different rules - which is exactly how one of them ends up
   * skipping a check.
   *
   * THE ELIGIBILITY IS RE-DECIDED HERE, ON THE SERVER, FROM THE SERVER'S OWN
   * READS. What a browser last saw may be minutes old: a salary may have been
   * rejected, a regularization raised, the month locked. The request says WHO,
   * and the server decides everything else - including, for each employee,
   * whether they are in the caller's branch scope at all.
   *
   * ROW-LEVEL FAILURES ARE REPORTED, NEVER THROWN. Twenty employees where one
   * is blocked must initialize nineteen and say why the twentieth was not;
   * refusing the batch would make bulk initialization unusable on any real
   * month, since a month always has somebody outstanding.
   *
   * AND THE WRITE ITSELF IS ALL-OR-NOTHING. The rows that PASSED are inserted
   * in ONE transaction (see `repository/payrun.js#insertSnapshots`), so a
   * failure halfway cannot leave a month half-initialized. "Report row-level
   * failures" and "be transaction-safe" are not in tension: the eligibility
   * decision is per row, the storage is atomic.
   *
   * REPEATING IT CHANGES NOTHING. An employee who already has a snapshot comes
   * back as ALREADY_INITIALIZED and their stored row is not touched - not
   * their gross, not their attendance reference, and not a pay type somebody
   * changed by hand. The database's unique key is what guarantees this; the
   * code merely reports it well.
   */
  async initialize({ year, month, employee_ids, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds(employee_ids);

    const view = await this.getMonth({
      year: period.year,
      month: period.month,
      store_ids,
    });

    if (view.month_locked) {
      throw validationError(
        `Payroll month ${period.year}-${String(period.month).padStart(2, "0")} is locked and cannot be initialized`
      );
    }

    const byId = new Map(view.rows.map((row) => [row.employee_id, row]));
    const results = [];
    const toInsert = [];

    ids.forEach((employeeId) => {
      const row = byId.get(employeeId);
      if (!row) {
        /*
         * NOT IN THE MONTH'S POPULATION, OR NOT IN THIS CALLER'S BRANCHES -
         * and the two are deliberately ONE outcome. Telling a caller which of
         * the two it was would confirm the existence of an employee they are
         * not allowed to see.
         */
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message: "This employee is not in the selected month's payroll population, or is outside your branch scope",
        });
        return;
      }
      if (row.initialized) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.ALREADY_INITIALIZED,
          message: "Already initialized for this month. Nothing was changed.",
        });
        return;
      }
      if (row.status !== STATUS_GROUP.READY) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.BLOCKED,
          blocking_reasons: row.blocking_reasons,
          message: row.blocking_reasons.map((r) => r.message).join("; "),
        });
        return;
      }
      toInsert.push(row);
    });

    if (toInsert.length > 0) {
      const source = await this._snapshotSources(period, toInsert.map((r) => r.employee_id), store_ids);
      const rows = toInsert.map((row) => this._snapshotRow(period, row, source, actor));
      await this.repo.insertSnapshots(rows);
      toInsert.forEach((row) => {
        results.push({
          employee_id: row.employee_id,
          result: ROW_RESULT.INITIALIZED,
          pay_type: row.pay_type,
          message: "Initialized",
        });
      });
    }

    const counted = (code) => results.filter((r) => r.result === code).length;
    return {
      period_year: period.year,
      period_month: period.month,
      initialized_count: counted(ROW_RESULT.INITIALIZED),
      already_initialized_count: counted(ROW_RESULT.ALREADY_INITIALIZED),
      blocked_count: counted(ROW_RESULT.BLOCKED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      // Ordered as the caller asked, so a screen can line the outcomes up
      // against the rows somebody ticked.
      results: ids.map((id) => results.find((r) => r.employee_id === id)),
    };
  }

  /**
   * The full source records for the employees about to be snapshotted.
   *
   * READ AGAIN RATHER THAN CARRIED THROUGH `getMonth`, because `getMonth`
   * deliberately drops most of what a snapshot has to store - the structure
   * components, the statutory identifiers, the attendance reference - so that
   * merely LOOKING at a payroll month does not send every reader an employee's
   * PF number. The snapshot needs them; the screen does not.
   */
  async _snapshotSources(period, employeeIds, store_ids) {
    const { to } = monthWindow(period.year, period.month);
    const [population, salaries, attendance] = await Promise.all([
      this.repo.listPopulation({ year: period.year, month: period.month, store_ids }),
      this.repo.listApprovedSalaries(employeeIds, to),
      this.repo.listAttendanceMonths(employeeIds, period.year, period.month),
    ]);
    const index = (rows) => {
      const map = new Map();
      (rows || []).forEach((row) => {
        if (!map.has(row.employee_id)) map.set(row.employee_id, row);
      });
      return map;
    };
    return {
      employees: index(population),
      salaries: index(salaries),
      attendance: index(attendance),
    };
  }

  /**
   * ONE SNAPSHOT ROW, built key by key from the SERVER's records.
   *
   * Built key by key rather than spread from anything, for the same reason
   * `usecase/employee_salary.js` builds its insert that way: a spread carries
   * whatever it was handed, and the day something hands it a request body, a
   * client-supplied gross is in the database.
   */
  _snapshotRow(period, row, source, actor) {
    const employee = source.employees.get(row.employee_id) || {};
    const salary = source.salaries.get(row.employee_id) || {};
    const attendance = source.attendance.get(row.employee_id) || {};

    return {
      period_year: period.year,
      period_month: period.month,
      employee_id: row.employee_id,
      employee_name: employee.employee_name || null,
      store_id: employee.store_id ?? null,
      store_name: employee.store_name || null,
      designation_id: employee.designation_id ?? null,
      designation_name: employee.designation_name || null,
      department_id: employee.department_id ?? null,
      date_of_joining: employee.date_of_joining || null,
      resignation_date: employee.resignation_date || null,

      salary_id: salary.salary_id ?? null,
      salary_effective_from: salary.effective_from || null,
      monthly_gross: salary.monthly_gross ?? null,
      daily_salary: salary.daily_salary ?? null,
      basic: salary.basic ?? null,
      conveyance: salary.conveyance ?? null,
      hra: salary.hra ?? null,
      special_allowance: salary.special_allowance ?? null,

      pf_applicable: employee.pf_applicable ?? null,
      esi_applicable: employee.esi_applicable ?? null,
      uan: employee.uan || null,
      pf_number: employee.pf_number || null,
      esi_number: employee.esi_number || null,

      attendance_monthly_payroll_id: attendance.attendance_monthly_payroll_id ?? null,
      attendance_payroll_version: attendance.payroll_version ?? null,
      attendance_calculated_at: attendance.calculated_at || null,

      pay_type: row.pay_type,
      pay_type_source: row.pay_type_source,
      status: PAYRUN_STATUS.INITIALIZED,
      initialized_by: actor && actor.employeeId !== undefined ? actor.employeeId : null,
    };
  }

  /**
   * CHANGE THIS MONTH'S PAY TYPE FOR ONE EMPLOYEE.
   *
   * IT IS A FACT ABOUT THE MONTH, NOT ABOUT THE PERSON. Nothing on this path
   * writes `new_employee.payment_type`, and the repository has no statement
   * that could: next month's payrun defaults from the Employee Master again,
   * exactly as this one did. Somebody paid in cash for December because their
   * account was closed is back on Bank in January unless HR changed the
   * master deliberately, through the Employee Master, under its own key.
   *
   * ONLY AN INITIALIZED MONTH HAS A PAY TYPE TO CHANGE. Before the snapshot
   * exists there is nothing month-specific to write, and writing one would
   * amount to initializing the employee through a side door that skips every
   * eligibility rule.
   *
   * A LOCKED MONTH REFUSES. The pay type is part of what a locked month has
   * already committed to.
   *
   * NO REASON IS REQUIRED, deliberately - see the audit-table note in the
   * migration - but WHO and WHEN always are, and they are recorded in the same
   * transaction as the change.
   */
  async changePayType({ year, month, employee_id, pay_type, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const employeeId = intOrNull(employee_id);
    if (employeeId === null || employeeId <= 0) {
      throw validationError("employee_id must be a positive integer");
    }
    const payType = normalizePayType(pay_type);

    const periodRow = await this.repo.getPeriod(period.year, period.month);
    if (periodRow && periodRow.status === PERIOD_STATUS.LOCKED) {
      throw validationError(
        `Payroll month ${period.year}-${String(period.month).padStart(2, "0")} is locked and cannot be changed`
      );
    }

    /*
     * THE BRANCH SCOPE IS APPLIED TO THE WRITE, not only to the read. An
     * employee id in a body is a claim, and the only thing this layer does
     * with a claim about somebody outside the caller's branches is refuse it -
     * in the same words as an employee who has no snapshot, so the refusal
     * confirms nothing about who exists.
     */
    /*
     * AN APPROVED EMPLOYEE'S PAY TYPE IS FROZEN. Approval locks the whole of
     * what the month says about that person, and HOW the money travels is
     * recorded on the calculation they signed off. It is checked BEFORE the
     * scope read so that a locked employee is refused in the same words
     * whoever asks, and it locks one employee: everybody else in the month is
     * as changeable as they were.
     */
    if (this.calculationLocks) {
      const locked = await this.calculationLocks.listLockedEmployeeIds({
        year: period.year,
        month: period.month,
        employee_ids: [employeeId],
      });
      if ((locked || []).map(Number).includes(employeeId)) {
        throw validationError(
          "This employee's payroll for the month has been approved and locked. Their pay type cannot be changed."
        );
      }
    }

    const population = await this.repo.listPopulation({
      year: period.year,
      month: period.month,
      store_ids,
    });
    const inScope = population.some((e) => Number(e.employee_id) === employeeId);

    const changed = inScope
      ? await this.repo.changePayType({
          year: period.year,
          month: period.month,
          employee_id: employeeId,
          pay_type: payType,
          changed_by: actor && actor.employeeId !== undefined ? actor.employeeId : null,
        })
      : null;

    if (!changed) {
      const err = new Error(
        "This employee has no initialized payrun for the selected month, or is outside your branch scope"
      );
      err.name = "NotFoundError";
      throw err;
    }

    return {
      period_year: period.year,
      period_month: period.month,
      employee_id: employeeId,
      old_pay_type: changed.old_pay_type,
      pay_type: changed.new_pay_type,
      pay_type_source: changed.changed ? PAY_TYPE_SOURCE.MANUAL : undefined,
      changed: changed.changed,
    };
  }

  /** The pay type history for one employee's month. */
  async getPayTypeAudit({ year, month, employee_id }) {
    const period = normalizeMonth(year, month);
    const employeeId = intOrNull(employee_id);
    if (employeeId === null || employeeId <= 0) {
      throw validationError("employee_id must be a positive integer");
    }
    return this.repo.listPayTypeAudit({
      year: period.year,
      month: period.month,
      employee_id: employeeId,
    });
  }
}

module.exports = (payrunRepo, calculationLocks = null) =>
  new PayrunUsecase(payrunRepo, calculationLocks);
module.exports.PayrunUsecase = PayrunUsecase;
module.exports.ROW_RESULT = ROW_RESULT;
module.exports.PAY_TYPE = PAY_TYPE;
module.exports.validationError = validationError;
module.exports.normalizeMonth = normalizeMonth;
module.exports.normalizePayType = normalizePayType;
module.exports.normalizeEmployeeIds = normalizeEmployeeIds;
