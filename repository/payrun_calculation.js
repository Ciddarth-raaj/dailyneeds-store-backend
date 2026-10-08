const { dayRowsSql, monthFreshness } = require("../utils/attendance_month_freshness");
const { closePendingPermissionsForLock } = require("./lib/attendance_permission_guard");
const logger = require("../utils/logger");
const { activeOverrideCondition } = require("../utils/shift_override_active");
const { JOINED_ON } = require("../utils/joining_date");
const { effectiveAttendanceMonth } = require("../utils/attendance_month_effective");
const {
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { locationPredicate } = require("./payrun");
const { monthWindow } = require("../utils/payrun_eligibility");
const {
  AUDIT_ACTION,
  STORED_STATUS,
  LIFECYCLE_ACTION: AUDIT_ACTION_LIFECYCLE,
  CALC_STATUS,
} = require("../constants/payrun_calculation");
const {
  resolveEffectiveNrm,
  sourceMarkers,
  attendanceSourceChanges,
} = require("../utils/payrun_calculation");
const { governsEmployeeMonth } = require("../utils/shift_propagation");
const { istToday } = require("../utils/istDate");

/**
 * Payrun Calculation & Review - the reads a calculated month needs, and the
 * writes that calculate, recalculate, lock and reset one.
 *
 * EVERY READ IS BATCHED ACROSS THE WHOLE MONTH'S POPULATION, for the reason
 * `repository/payrun.js` and `repository/attendance_dashboard.js` both state:
 * a screen covering six hundred employees cannot afford a per-employee query.
 *
 * IT CALCULATES NOTHING. There is no salary arithmetic, no attendance
 * arithmetic, no PF and no ESI in this file. It reads what the attendance
 * engine, the salary lifecycle and the adjustments stage already stored, and
 * `utils/payrun_calculation.js` - which is pure - decides what it means.
 *
 * IT NEVER WRITES OUTSIDE ITS OWN TABLES (the calculation, its audit log and
 * the reset audit). There is no UPDATE of
 * `payrun_employee`, `payrun_employee_adjustment`, `employee_salary`,
 * `new_employee` or any attendance table anywhere below. In particular,
 * CALCULATING A MONTH DOES NOT TOUCH THE SNAPSHOT: the snapshot is what the
 * month was initialized from, and a calculation is a separate row that reads
 * it.
 *
 * EVERY DATE LEAVES AS A STRING, through DATE_FORMAT, exactly as the payrun
 * and attendance repositories do it - the API pool has no `dateStrings`
 * option, and a payroll month is one of the places an off-by-one day is most
 * expensive.
 *
 * `locationPredicate` IS IMPORTED RATHER THAN RESTATED. It is the fail-closed
 * branch scope - `null` is company-wide, `[]` is NO branches expressed as
 * `1 = 0` - and a second copy of it is a second chance to get the empty case
 * backwards, which is the case that leaks a whole company's payroll.
 */
/**
 * Move one employee-month's prior-month OT from one settlement status to the
 * next, on the caller's connection and transaction, with a log row per item.
 * A database without the table (before migration 20261126120000) has nothing
 * to move. Returns how many moved.
 */
async function moveLateOt(conn, repo, { employee_id, year, month, from, to, actor = null, note = null }) {
  const run = (code, sql, params) =>
    new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  try {
    const items = await run(
      "LATE-OT-FOR-MOVE",
      `SELECT late_settlement_id, attendance_approval_request_id
         FROM attendance_ot_late_settlement
        WHERE employee_id = ? AND settlement_status = ? AND settlement_year = ? AND settlement_month = ?
        FOR UPDATE`,
      [employee_id, from, year, month]
    );
    if (!Array.isArray(items) || items.length === 0) return 0;
    const ids = items.map((i) => i.late_settlement_id);
    await run(
      "LATE-OT-MOVE",
      `UPDATE attendance_ot_late_settlement
          SET settlement_status = ?,
              settled_at = CASE WHEN ? = 'SETTLED' THEN CURRENT_TIMESTAMP(3) WHEN ? = 'INCLUDED' THEN NULL ELSE settled_at END,
              settlement_year = CASE WHEN ? = 'PENDING_SETTLEMENT' THEN NULL ELSE settlement_year END,
              settlement_month = CASE WHEN ? = 'PENDING_SETTLEMENT' THEN NULL ELSE settlement_month END,
              settlement_payrun_calculation_id = CASE WHEN ? = 'PENDING_SETTLEMENT' THEN NULL ELSE settlement_payrun_calculation_id END,
              included_at = CASE WHEN ? = 'PENDING_SETTLEMENT' THEN NULL ELSE included_at END
        WHERE late_settlement_id IN (?) AND settlement_status = ?`,
      [to, to, to, to, to, to, to, ids, from]
    );
    await run(
      "LATE-OT-MOVE-LOG",
      `INSERT INTO attendance_ot_late_settlement_log
         (late_settlement_id, attendance_approval_request_id, from_status, to_status,
          settlement_year, settlement_month, actor_employee_id, note)
       VALUES ?`,
      [items.map((i) => [i.late_settlement_id, i.attendance_approval_request_id, from, to, year, month, actor, note])]
    );
    return ids.length;
  } catch (err) {
    if (err && err.code === "ER_NO_SUCH_TABLE") return 0;
    repo._log("MOVE-LATE-OT", err);
    throw err;
  }
}

class PayrunCalculationRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * TRUE when the Prior-Month OT this stored calculation pays is no longer
   * exactly the set INCLUDED for its month - read FOR UPDATE inside Approve &
   * Lock's transaction. A database without the table or column has none.
   */
  async _lateOtMovedLocked(conn, { row, year, month }) {
    const run = (sql, params) =>
      new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    try {
      const storedRows = await run(
        "SELECT prior_month_ot FROM payrun_employee_calculation WHERE payrun_calculation_id = ?",
        [row.payrun_calculation_id]
      );
      const stored = Array.isArray(storedRows) ? storedRows[0] : null;
      let paid = stored && stored.prior_month_ot;
      if (typeof paid === "string") paid = JSON.parse(paid);
      const paidIds = (Array.isArray(paid) ? paid : [])
        .map((i) => Number(i.late_settlement_id))
        .filter((id) => Number.isFinite(id))
        .sort((a, b) => a - b);
      const included = await run(
        `SELECT late_settlement_id FROM attendance_ot_late_settlement
          WHERE employee_id = ? AND settlement_status = 'INCLUDED' AND settlement_year = ? AND settlement_month = ?
          FOR UPDATE`,
        [row.employee_id, year, month]
      );
      const includedIds = (Array.isArray(included) ? included : []).map((i) => Number(i.late_settlement_id)).sort((a, b) => a - b);
      return paidIds.join(",") !== includedIds.join(",");
    } catch (err) {
      if (err && (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_FIELD_ERROR")) return false;
      this._log("LATE-OT-MOVED-LOCKED", err);
      throw err;
    }
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.PAYRUN_CALCULATION",
      code: `REPOSITORY.PAYRUN_CALCULATION.${code}`,
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

  /* ---------------------------------------------------------- the reads */

  /**
   * THE MONTH'S POPULATION: everybody INITIALIZED for it.
   *
   * THE CALCULATION STAGE'S POPULATION IS THE SNAPSHOT'S, exactly as the
   * adjustments stage's is. An employee with no snapshot has no month to
   * calculate, and pulling them in from `new_employee` would be initializing
   * them through a side door that skips every eligibility rule.
   *
   * THE WHOLE SNAPSHOT IS READ, not a summary of it, because the calculation
   * is performed FROM the snapshot: the structure components, the statutory
   * flags and the frozen pay type are its inputs. The account number, the
   * Aadhaar and the PAN are not among them and are not selected.
   *
   * THE ATTENDANCE CLOSE COMES WITH IT. Whether payroll accepted this
   * employee's attendance as it stood is a fact ABOUT this month's snapshot,
   * and the approval gate needs it for every row - reading it here rather than
   * per employee is the batching rule this file exists to keep.
   */
  async listInitialized({ year, month, store_ids = null, employee_ids = null }) {
    const where = ["pe.period_year = ?", "pe.period_month = ?"];
    const params = [year, month];

    const location = locationPredicate("pe.store_id", store_ids);
    if (location.clause) {
      where.push(location.clause);
      params.push(...location.params);
    }
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      where.push("pe.employee_id IN (?)");
      params.push(employee_ids);
    }

    return this._read(
      "LIST-INITIALIZED",
      `SELECT pe.payrun_employee_id, pe.employee_id, pe.employee_name,
              pe.store_id, pe.store_name, pe.designation_id, pe.designation_name,
              pe.department_id,
              DATE_FORMAT(pe.date_of_joining, '%Y-%m-%d')  AS date_of_joining,
              DATE_FORMAT(pe.resignation_date, '%Y-%m-%d') AS resignation_date,
              pe.salary_id,
              DATE_FORMAT(pe.salary_effective_from, '%Y-%m-%d') AS salary_effective_from,
              pe.monthly_gross, pe.daily_salary,
              pe.basic, pe.conveyance, pe.hra, pe.special_allowance,
              pe.pf_applicable, pe.esi_applicable, pe.uan, pe.pf_number, pe.esi_number,
              pe.pay_type, pe.pay_type_source,
              pe.attendance_closed_for_payroll,
              pe.attendance_closed_by,
              DATE_FORMAT(pe.attendance_closed_at, '%Y-%m-%d %H:%i:%s') AS attendance_closed_at
         FROM payrun_employee pe
        WHERE ${where.join(" AND ")}
        ORDER BY pe.employee_id`,
      params
    );
  }

  /**
   * APPROVED SALARY RECORDS BY ID - the structure a stored calculation was
   * priced on, for the payslip's component split. `employee_salary` rows are
   * immutable once approved, so the id names exactly one structure for ever.
   */
  async listSalariesByIds(salaryIds) {
    const ids = (salaryIds || []).filter((id) => id !== null && id !== undefined);
    if (ids.length === 0) return [];
    return this._read(
      "LIST-SALARIES-BY-IDS",
      `SELECT salary_id, employee_id, monthly_gross, daily_salary,
              basic, conveyance, hra, special_allowance,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from, status,
              pf_status, employee_pf, employer_pf_total, edli, pf_admin_charge,
              esi_status, esi_wage, employee_esi, employer_esi,
              monthly_ctc, ctc_status, unresolved_notes, statutory_snapshot
         FROM employee_salary
        WHERE salary_id IN (?)`,
      [ids]
    );
  }

  /**
   * THE DEPARTMENT NAMES FOR THE REVIEW SCREEN'S DEPARTMENT FILTER.
   *
   * The snapshot carries `department_id` and not the name, so the name is
   * read from the Employee Master's own `department` table - the same table
   * `repository/employee_master.js` joins. It is a separate read on purpose:
   * joining it into `listInitialized` would put a second table into the read
   * every calculation and approval is made from, for a label.
   */
  async listDepartmentNames(departmentIds) {
    if (!Array.isArray(departmentIds) || departmentIds.length === 0) return [];
    return this._read(
      "LIST-DEPARTMENT-NAMES",
      `SELECT department_id, department_name
         FROM department
        WHERE department_id IN (?)`,
      [departmentIds]
    );
  }

  /**
   * THE STORED ATTENDANCE MONTH, WITH ITS FIGURES THIS TIME.
   *
   * `repository/payrun.js#listAttendanceMonths` reads the same table and
   * deliberately takes only the reference and the version markers, because
   * INITIALIZATION does not need the numbers. CALCULATION does - Salary Days,
   * Extra Days, the shortage and its deduction, and the approved OT minutes
   * are its inputs - so this read takes them.
   *
   * IT STILL RECOMPUTES NOTHING. Every column below is stored by
   * `usecase/attendance_calculation.js#calculateMonth`; this statement selects
   * them and no expression in it derives one.
   */
  async listAttendanceMonths(employeeIds, year, month, conn = null) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    const rows = await this._read(
      "LIST-ATTENDANCE-MONTHS",
      `SELECT attendance_monthly_payroll_id, employee_id, is_final, payroll_version,
              held_dates,
              DATE_FORMAT(available_from, '%Y-%m-%d') AS available_from,
              DATE_FORMAT(available_to, '%Y-%m-%d') AS available_to,
              salary_days, extra_days, base_days,
              monthly_gross, daily_rate,
              salary_day_earnings, extra_day_earnings,
              shortage_minutes, missing_minute_deduction,
              approved_ot_minutes, approved_ot_earnings,
              DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS calculated_at,
              day_rows_fingerprint
         FROM attendance_monthly_payroll
        WHERE employee_id IN (?) AND period_year = ? AND period_month = ?`,
      [employeeIds, year, month],
      conn
    );
    // Dates outside the employment period never hold a month - even on a
    // summary stored before that boundary was enforced. See the util.
    return (rows || []).map(effectiveAttendanceMonth);
  }

  /**
   * THE STORED ATTENDANCE DAYS OF THE MONTH, FOR THE WHOLE POPULATION AT ONCE -
   * what payroll readiness (`utils/payroll_readiness.js`) judges attendance
   * completion from, exactly as the Attendance module and Approve & Lock do.
   *
   * THE SAME COLUMNS, IN THE SAME FORMATS, AS `dayRowsSql` - the statement the
   * month persist fingerprints its days with - so the fingerprint computed from
   * these rows is comparable with the one the summary recorded. Only
   * `employee_id` is added (to split the batch) and `status` already is one of
   * the fingerprint fields. Read only.
   */
  async listAttendanceDayRows(employeeIds, from, to) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-ATTENDANCE-DAY-ROWS",
      `SELECT employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              status, is_final, attendance_day_count, nrm_minutes, base_nrm_minutes,
              worked_minutes, shortage_minutes, approved_ot_minutes, ot_rate,
              permission_minutes, calculation_version, attendance_calculation_mode
         FROM attendance_day_calculation
        WHERE employee_id IN (?)
          AND attendance_date BETWEEN ? AND ?
        ORDER BY employee_id, attendance_date ASC`,
      [employeeIds, from, to]
    );
  }

  /**
   * THE EFFECTIVE NRM EVIDENCE, GROUPED, FOR THE WHOLE POPULATION AT ONCE.
   *
   * WHAT THIS IS AND WHAT IT IS NOT. It is the NRM the ATTENDANCE ENGINE
   * resolved per date - `attendance_day_calculation.nrm_minutes`, which is the
   * shift span less the allowed break, with the employee's own
   * `special_break_override_minutes` already applied - grouped by the distinct
   * values a month contained. It is NOT a read of `work_shift`,
   * `work_shift_weekly_schedule` or `new_employee.special_break_override_minutes`:
   * the payrun must not derive an NRM from the shift master when attendance
   * has already resolved the employee-specific one, and the way to guarantee
   * that is to have no statement here that could.
   *
   * GROUPED RATHER THAN ROLLED UP IN SQL, because which group WINS is a
   * business rule - the days that carried the approved overtime, then the days
   * that carried the month - and business rules live in
   * `utils/payrun_calculation.js#resolveEffectiveNrm` where they can be tested
   * without a database. A `GROUP BY` that picked the winner would be that rule
   * written in SQL, untested, in a second place.
   *
   * ONLY FINAL DATES COUNT. A date the engine has not settled has a punch list
   * known to be incomplete, and its NRM is not evidence of anything.
   */
  async listEffectiveNrm(employeeIds, from, to, conn = null) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-EFFECTIVE-NRM",
      // THE EMPLOYMENT PERIOD BOUNDS THE EVIDENCE: a row stored for a date
      // before somebody joined or after their last working date (written
      // before those boundaries were enforced) is not a day of theirs and
      // must not decide their NRM.
      `SELECT c.employee_id,
              c.nrm_minutes,
              c.break_allowance_source,
              COUNT(*) AS day_count,
              SUM(c.approved_ot_minutes) AS approved_ot_minutes
         FROM attendance_day_calculation c
         JOIN new_employee ne ON ne.employee_id = c.employee_id
        WHERE c.employee_id IN (?)
          AND c.attendance_date >= ? AND c.attendance_date <= ?
          AND ((${JOINED_ON("ne")}) IS NULL OR c.attendance_date >= (${JOINED_ON("ne")}))
          AND (ne.resignation_date IS NULL OR c.attendance_date <= ne.resignation_date)
          AND c.is_final = 1
          AND c.nrm_minutes > 0
        GROUP BY c.employee_id, c.nrm_minutes, c.break_allowance_source
        ORDER BY c.employee_id`,
      [employeeIds, from, to],
      conn
    );
  }

  /**
   * THE STATUTORY CONTEXT THE PF SPLIT NEEDS, for the whole population.
   *
   * THE SAME SIX FACTS `repository/employee_salary.js#getStatutoryContext`
   * reads for ONE employee, and deliberately the same list: calculating
   * somebody's provident fund is not a reason to read their identity
   * documents. This is the batched twin of that statement, not a wider one.
   *
   * WHY IT IS READ LIVE RATHER THAN FROM THE SNAPSHOT. The snapshot froze the
   * APPLICABILITY flags, which is what decides whether a contribution is
   * charged at all; `dob` and `previous_eps_member` decide only how the
   * employer's 12% is SPLIT between EPF and EPS, they are biographical rather
   * than monthly, and there is no version of them that belongs to August. The
   * applicability flags on the snapshot remain the ones the calculation uses.
   */
  async listStatutoryContext(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-STATUTORY-CONTEXT",
      `SELECT ne.employee_id,
              ne.attendance_required,
              ne.pf_applicable,
              ne.esi_applicable,
              ne.previous_eps_member,
              ne.previous_pf_member,
              DATE_FORMAT(ne.pf_applicable_from, '%Y-%m-%d') AS pf_applicable_from,
              ne.pf_contribution_basis,
              ne.uan,
              ne.pf_number,
              DATE_FORMAT(ne.dob, '%Y-%m-%d') AS dob,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS date_of_joining
         FROM new_employee ne
        WHERE ne.employee_id IN (?)`,
      [employeeIds]
    );
  }

  /** The stored calculations for the month. */
  async listCalculations({ year, month, employee_ids = null }, conn = null) {
    const params = [year, month];
    let clause = "period_year = ? AND period_month = ?";
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause += " AND employee_id IN (?)";
      params.push(employee_ids);
    }
    return this._read(
      "LIST-CALCULATIONS",
      `SELECT payrun_calculation_id, payrun_employee_id, employee_id,
              salary_id,
              DATE_FORMAT(salary_effective_from, '%Y-%m-%d') AS salary_effective_from,
              monthly_gross,
              attendance_monthly_payroll_id, attendance_payroll_version,
              DATE_FORMAT(attendance_calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS attendance_calculated_at,
              effective_nrm_minutes, effective_nrm_source,
              pf_applicable, esi_applicable,
              source_hash, inputs_hash,
              daily_rate, salary_days, salary_earnings,
              missing_hours_minutes, missing_hours_deduction,
              extra_days, extra_day_amount,
              approved_ot_minutes, approved_ot_hours, ot_hourly_rate, ot_amount,
              ot_groups, attendance_ot_earnings,
              prior_month_ot_amount, prior_month_ot,
              incentive, bonus, arrears, advance_recovery, shortage_recovery,
              balance_advance,
              pf_status, pf_wage, employee_pf, employer_pf_total, employer_epf, employer_eps,
              eps_wage, edli_wage, edli, pf_admin_charge, ncp_days,
              pf_ceiling_version, statutory_config_version, pf_segments,
              pf_scenario, pf_exact, statutory_setup_marker,
              esi_status, esi_wage, esi_wage_basis, employee_esi, employer_esi,
              DATE_FORMAT(esi_period_start, '%Y-%m-%d') AS esi_period_start,
              DATE_FORMAT(esi_period_end, '%Y-%m-%d')   AS esi_period_end,
              DATE_FORMAT(esi_coverage_entry_date, '%Y-%m-%d') AS esi_coverage_entry_date,
              esi_coverage_entry_salary_id, esi_coverage_entry_gross, esi_coverage_basis,
              esi_contribution_period_continues,
              total_earnings, total_employee_deductions, net_pay, net_pay_rounding, pay_type,
              unresolved, errors, is_complete,
              calculation_version, calculation_revision, calculation_hash,
              DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s') AS calculated_at,
              calculated_by,
              status,
              approved_by, DATE_FORMAT(approved_at, '%Y-%m-%d %H:%i:%s') AS approved_at,
              locked_by,   DATE_FORMAT(locked_at,   '%Y-%m-%d %H:%i:%s') AS locked_at,
              published_by, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS published_at,
              unlocked_by, DATE_FORMAT(unlocked_at, '%Y-%m-%d %H:%i:%s') AS unlocked_at, unlock_reason
         FROM payrun_employee_calculation
        WHERE ${clause}
        ORDER BY employee_id`,
      params,
      conn
    );
  }

  /**
   * PRIOR-MONTH OT THIS PAYROLL MONTH SETTLES, per employee: every
   * late-approved OT still PENDING_SETTLEMENT from an EARLIER month - or from
   * THIS month itself, once it has been unlocked again - and
   * every one this month already INCLUDED - or, once it is locked, SETTLED -
   * so a recalculation keeps exactly what it had, never picks one up twice,
   * and a locked month's inputs still read as what it consumed (publish
   * compares them). One read for the population.
   * A database without the table (before migration 20261126120000) has none.
   */
  async listLateOtForSettlement(employeeIds, year, month) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    try {
      return await new Promise((resolve, reject) => {
        this.db.query(
          `SELECT late_settlement_id, attendance_approval_request_id, employee_id,
                  DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
                  source_year, source_month, eligible_ot_minutes, approved_ot_minutes,
                  source_daily_rate AS daily_rate, nrm_minutes, ot_hourly_rate, amount,
                  settlement_status, settlement_year, settlement_month
             FROM attendance_ot_late_settlement s
            WHERE s.employee_id IN (?)
              AND (
                    (s.settlement_status = 'PENDING_SETTLEMENT'
                       /* ITS OWN MONTH TOO. An OT approved while its month
                          was locked is parked here; if that month is then
                          unlocked, it is open again and is where the OT
                          belongs. Without the equality the minutes stayed
                          parked until a LATER month was calculated, and the
                          reopened month's payroll showed no approved OT at
                          all although Attendance said "OT Approved". The
                          claim below still lets only ONE month take it. */
                       AND (s.source_year * 12 + s.source_month) <= (? * 12 + ?)
                       /* A LOCKED month takes nothing new: an item approved
                          after it locked waits for the next open month, and
                          the locked month's inputs stay what it was locked
                          with (otherwise its Publish reads "changed"). */
                       AND NOT EXISTS (
                             SELECT 1 FROM payrun_employee_calculation c
                              WHERE c.employee_id = s.employee_id
                                AND c.period_year = ? AND c.period_month = ?
                                AND c.status = 'APPROVED_LOCKED'))
                 OR (s.settlement_status IN ('INCLUDED','SETTLED') AND s.settlement_year = ? AND s.settlement_month = ?)
                  )
            ORDER BY s.employee_id, s.attendance_date, s.attendance_approval_request_id`,
          [employeeIds, year, month, year, month, year, month],
          (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
      });
    } catch (err) {
      if (err && err.code === "ER_NO_SUCH_TABLE") return [];
      this._log("LIST-LATE-OT-FOR-SETTLEMENT", err);
      throw err;
    }
  }

  /**
   * WHICH OF THESE EMPLOYEES' MONTHS ARE LOCKED.
   *
   * THE ONE READ THE OTHER STAGES NEED FROM THIS ONE. A locked employee's
   * adjustments may not be edited and their pay type may not be changed, and
   * the stage that owns each of those has to be able to ask. It answers with
   * ids and nothing else - the asking stage has no business reading a net pay
   * to find out whether it may save a remark.
   */
  async listLockedEmployeeIds({ year, month, employee_ids = null }, conn = null) {
    const params = [year, month, STORED_STATUS.APPROVED_LOCKED];
    let clause = "period_year = ? AND period_month = ? AND status = ?";
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause += " AND employee_id IN (?)";
      params.push(employee_ids);
    }
    const rows = await this._read(
      "LIST-LOCKED",
      `SELECT employee_id FROM payrun_employee_calculation WHERE ${clause}`,
      params,
      conn
    );
    return rows.map((r) => Number(r.employee_id));
  }

  /** One employee's calculation history for the month, newest first. */
  async listAudit({ year, month, employee_id }) {
    return this._read(
      "LIST-AUDIT",
      `SELECT payrun_calculation_audit_id, action, calculation_version,
              calculation_revision, calculation_hash, source_hash, net_pay,
              changed_by,
              DATE_FORMAT(changed_at, '%Y-%m-%d %H:%i:%s') AS changed_at
         FROM payrun_employee_calculation_audit
        WHERE period_year = ? AND period_month = ? AND employee_id = ?
        ORDER BY payrun_calculation_audit_id DESC`,
      [year, month, employee_id]
    );
  }

  /* --------------------------------------------------------- the writes */

  /** The columns a calculation row is written from. The order is the contract. */
  static get COLUMNS() {
    return [
      "payrun_employee_id", "period_year", "period_month", "employee_id",
      "salary_id", "salary_effective_from", "monthly_gross",
      "attendance_monthly_payroll_id", "attendance_payroll_version",
      "attendance_calculated_at",
      "effective_nrm_minutes", "effective_nrm_source",
      "pf_applicable", "esi_applicable",
      "source_hash", "inputs_hash",
      "daily_rate", "salary_days", "salary_earnings",
      "missing_hours_minutes", "missing_hours_deduction",
      "extra_days", "extra_day_amount",
      "approved_ot_minutes", "approved_ot_hours", "ot_hourly_rate", "ot_amount",
      "ot_groups", "attendance_ot_earnings",
      "prior_month_ot_amount", "prior_month_ot",
      "incentive", "bonus", "arrears", "advance_recovery", "shortage_recovery",
      "balance_advance",
      "pf_status", "pf_wage", "employee_pf", "employer_pf_total",
      "employer_epf", "employer_eps",
      "eps_wage", "edli_wage", "edli", "pf_admin_charge", "ncp_days",
      "pf_ceiling_version", "statutory_config_version", "pf_segments",
      "pf_scenario", "pf_exact", "statutory_setup_marker",
      "esi_status", "esi_wage", "esi_wage_basis", "employee_esi", "employer_esi",
      "esi_period_start", "esi_period_end", "esi_coverage_entry_date",
      "esi_coverage_entry_salary_id", "esi_coverage_entry_gross", "esi_coverage_basis",
      "esi_contribution_period_continues",
      "total_earnings", "total_employee_deductions", "net_pay", "net_pay_rounding", "pay_type",
      "unresolved", "errors", "is_complete",
      "calculation_version", "calculation_hash", "calculated_by",
    ];
  }

  /**
   * STORE A BATCH OF CALCULATIONS - all of them or none of them.
   *
   * ONE TRANSACTION FOR THE WHOLE BULK, for the reason
   * `repository/payrun.js#insertSnapshots` gives: a failure halfway through
   * "Calculate All Eligible" must not leave a month half calculated.
   *
   * INSERT ... ON DUPLICATE KEY UPDATE, WHICH IS WHAT MAKES A RECALCULATION A
   * RECALCULATION. The unique key on (year, month, employee) means a second
   * calculation for the same employee updates the first rather than appearing
   * beside it, and `calculation_revision` is incremented IN SQL -
   * `calculation_revision + 1` - rather than read, incremented and written
   * back, because the read-modify-write version is a race that two browser
   * tabs will eventually win.
   *
   * THE LOCK IS ENFORCED IN THE STATEMENT AS WELL AS IN THE USECASE. The
   * update clause is guarded so that a row whose `status` is APPROVED_LOCKED
   * keeps every one of its own values: even if a caller somehow reached this
   * method with a locked employee in its batch, the database would decline to
   * move a single figure. A locked payroll record that could be overwritten by
   * one forgotten check in an application layer is not locked.
   *
   * THE APPROVAL COLUMNS ARE NOT IN `COLUMNS` AT ALL, so no calculation can
   * write one. Approving is a separate method with a separate permission.
   */
  async saveCalculations(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const columns = PayrunCalculationRepository.COLUMNS;
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);

      const values = rows.map((row) =>
        columns.map((c) => (row[c] === undefined ? null : row[c]))
      );

      /*
       * `IF(status = 'APPROVED_LOCKED', <keep>, <new>)` on every column. Long,
       * and written out rather than generated, so that the guard is visible on
       * each line a recalculation could otherwise move.
       */
      const keepIfLocked = columns
        .filter((c) => !["payrun_employee_id", "period_year", "period_month", "employee_id"].includes(c))
        .map(
          (c) =>
            `\`${c}\` = IF(\`status\` = 'APPROVED_LOCKED', \`${c}\`, VALUES(\`${c}\`))`
        )
        .join(",\n              ");

      await this._read(
        "SAVE-CALCULATIONS",
        `INSERT INTO payrun_employee_calculation
                (${columns.map((c) => `\`${c}\``).join(", ")})
         VALUES ?
         ON DUPLICATE KEY UPDATE
              ${keepIfLocked},
              \`calculation_revision\` =
                IF(\`status\` = 'APPROVED_LOCKED', \`calculation_revision\`, \`calculation_revision\` + 1),
              \`calculated_at\` =
                IF(\`status\` = 'APPROVED_LOCKED', \`calculated_at\`, CURRENT_TIMESTAMP)`,
        [values],
        conn
      );

      const written = await this._read(
        "READ-BACK-CALCULATIONS",
        `SELECT employee_id, payrun_calculation_id, calculation_revision, status, net_pay,
                calculation_hash, source_hash, calculation_version
           FROM payrun_employee_calculation
          WHERE period_year = ? AND period_month = ? AND employee_id IN (?)`,
        [rows[0].period_year, rows[0].period_month, rows.map((r) => r.employee_id)],
        conn
      );

      /*
       * THE AUDIT ROWS MOVE WITH THE CALCULATION, in the same transaction, for
       * the reason `repository/payrun.js#changePayType` gives about its own
       * pair: a figure that changed with no audit row is a change nobody can
       * account for, and an audit row for a change that did not happen is
       * worse. The revision read back decides the verb - 1 is a first
       * CALCULATE, anything higher is a RECALCULATE - so the log says which
       * act it was without the application having to remember.
       */
      const byEmployee = new Map(written.map((w) => [Number(w.employee_id), w]));
      const auditValues = rows
        .filter((row) => {
          const w = byEmployee.get(Number(row.employee_id));
          return w && w.status !== STORED_STATUS.APPROVED_LOCKED;
        })
        .map((row) => {
          const w = byEmployee.get(Number(row.employee_id));
          return [
            row.payrun_employee_id,
            row.period_year,
            row.period_month,
            row.employee_id,
            Number(w.calculation_revision) > 1 ? AUDIT_ACTION.RECALCULATE : AUDIT_ACTION.CALCULATE,
            row.calculation_version,
            w.calculation_revision,
            row.calculation_hash,
            row.source_hash,
            row.net_pay,
            row.calculated_by,
          ];
        });

      /*
       * PRIOR-MONTH OT IS CLAIMED BY THIS MONTH, IN THIS TRANSACTION. Every
       * item the calculation priced moves to INCLUDED for this month - guarded
       * on still being PENDING_SETTLEMENT, or already INCLUDED in THIS month -
       * and if any one of them is not claimable any more (another month took
       * it, it was cancelled) the whole save rolls back. That is what makes a
       * second month unable to pay the same OT.
       */
      for (const row of rows) {
        const w = byEmployee.get(Number(row.employee_id));
        const items = Array.isArray(row.late_ot_settlement_ids) ? row.late_ot_settlement_ids : [];
        if (!w || w.status === STORED_STATUS.APPROVED_LOCKED || items.length === 0) continue;
        /* eslint-disable no-await-in-loop */
        const before = await this._read(
          "LOCK-LATE-OT-FOR-CLAIM",
          `SELECT late_settlement_id, attendance_approval_request_id, settlement_status
             FROM attendance_ot_late_settlement
            WHERE late_settlement_id IN (?) AND employee_id = ?
            FOR UPDATE`,
          [items, row.employee_id],
          conn
        );
        const claimable = (before || []).filter(
          (b) =>
            b.settlement_status === "PENDING_SETTLEMENT" ||
            b.settlement_status === "INCLUDED"
        );
        const claimed = await this._read(
          "CLAIM-LATE-OT",
          `UPDATE attendance_ot_late_settlement
              SET settlement_status = 'INCLUDED',
                  settlement_year = ?, settlement_month = ?,
                  settlement_payrun_calculation_id = ?,
                  included_at = COALESCE(included_at, CURRENT_TIMESTAMP(3))
            WHERE late_settlement_id IN (?)
              AND employee_id = ?
              AND (settlement_status = 'PENDING_SETTLEMENT'
                   OR (settlement_status = 'INCLUDED' AND settlement_year = ? AND settlement_month = ?))`,
          [row.period_year, row.period_month, w.payrun_calculation_id, items, row.employee_id, row.period_year, row.period_month],
          conn
        );
        if (claimable.length !== items.length || !claimed || Number(claimed.affectedRows) !== items.length) {
          const err = new Error(
            `Prior-month OT for employee ${row.employee_id} changed while it was being calculated - recalculate`
          );
          err.name = "ValidationError";
          err.code = "PRIOR_MONTH_OT_MOVED";
          throw err;
        }
        const newlyIncluded = claimable.filter((b) => b.settlement_status === "PENDING_SETTLEMENT");
        if (newlyIncluded.length > 0) {
          await this._read(
            "LOG-LATE-OT-INCLUDED",
            `INSERT INTO attendance_ot_late_settlement_log
               (late_settlement_id, attendance_approval_request_id, from_status, to_status,
                settlement_year, settlement_month, actor_employee_id, note)
             VALUES ?`,
            [newlyIncluded.map((b) => [
              b.late_settlement_id, b.attendance_approval_request_id, "PENDING_SETTLEMENT", "INCLUDED",
              row.period_year, row.period_month, row.calculated_by === undefined ? null : row.calculated_by,
              "included in the payroll calculation",
            ])],
            conn
          );
        }
        /* eslint-enable no-await-in-loop */
      }

      if (auditValues.length > 0) {
        await this._read(
          "INSERT-CALCULATION-AUDIT",
          `INSERT INTO payrun_employee_calculation_audit
                  (payrun_employee_id, period_year, period_month, employee_id,
                   action, calculation_version, calculation_revision,
                   calculation_hash, source_hash, net_pay, changed_by)
           VALUES ?`,
          [auditValues],
          conn
        );
      }

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
   * APPROVE AND LOCK - one employee or a selection, and EMPLOYEE BY EMPLOYEE.
   *
   * THE LOCK IS TAKEN IN THE DATABASE, NOT DECIDED IN THE APPLICATION. Each
   * row is re-read `FOR UPDATE` inside the transaction and the UPDATE carries
   * `AND status = 'CALCULATED'`, so two people approving the same employee at
   * the same moment produce ONE approval and one audit row; the second is told
   * the employee was already locked. An application-level "is it locked?"
   * check before an unguarded UPDATE is a race with a comment on it.
   *
   * THE CALCULATION HASH IS CHECKED AGAINST WHAT THE CALLER APPROVED. The
   * usecase passes the hash of the figures it showed; if the row has been
   * recalculated since - somebody else refreshed the month between the screen
   * loading and the button being pressed - the approval is refused rather than
   * applied to figures nobody looked at. That is the whole of what
   * "approval is recorded against a calculation reference" is for.
   *
   * ================ AND THE ATTENDANCE SOURCE IS RE-READ AFTER THE LOCK =====
   *
   * THE HASH ALONE WAS NOT ENOUGH, because it answers a different question.
   * `calculation_hash` says "has this payrun row been recalculated since you
   * looked at it"; it says nothing about whether the ATTENDANCE the row was
   * calculated from has moved, because attendance moving does not touch the
   * payrun row at all. The readiness verdict that DOES compare sources is
   * computed by `_present`, before this transaction begins, which left:
   *
   *   1  the usecase assembles and finds the employee READY
   *   2  an attendance write takes this payrun row FOR UPDATE, rewrites the
   *      employee's attendance, and commits
   *   3  this approval wakes, takes the row lock, finds `calculation_hash`
   *      unchanged - because nothing recalculated the PAYRUN - and approves
   *   4  a month is approved against attendance nobody priced
   *
   * So the attendance markers are read again HERE, on this connection, INSIDE
   * this transaction, AFTER the row lock, and compared against the ones the
   * stored calculation carries. Attendance writers take the same row lock
   * before modifying attendance (`repository/attendance_calculation.js`), so
   * the two orderings are both settled:
   *
   *   approval first     it locks, revalidates, approves; the attendance
   *                      write then wakes, sees APPROVED_LOCKED and refuses
   *   attendance first   it locks, writes, commits; this approval then wakes,
   *                      re-reads attendance, finds it no longer matches the
   *                      stored calculation and refuses as SOURCE_MOVED
   *
   * The comparison is the EXISTING source-marker architecture, narrowed to the
   * attendance keys - `utils/payrun_calculation.js#attendanceSourceChanges`
   * over `ATTENDANCE_SOURCE_KEYS` - and not a second definition of freshness.
   * Only attendance is re-read: it is the source this lock serializes against,
   * and re-reading the salary, the statutory flags and the ESI coverage
   * evidence inside a held lock would buy nothing the pre-lock readiness check
   * does not already cover.
   *
   * IT LOCKS ONE EMPLOYEE, NEVER THE MONTH. Nothing here writes
   * `payrun_period`, and there is no statement in this file that could: a
   * month-wide lock is exactly what the specification forbids, and the way to
   * guarantee it is not to have the capability.
   */
  /**
   * THE ATTENDANCE SOURCE, RE-READ ON A HELD LOCK.
   *
   * Runs on the connection it is given - the approval's own, inside the
   * approval's transaction, after the row is locked - so what it reads is what
   * is true at the moment of approval and cannot change before the status
   * does. The reads are the SAME two the assembly uses (`listAttendanceMonths`
   * and `listEffectiveNrm`), narrowed to one employee, and the markers are
   * built by the SAME `sourceMarkers`, so this cannot drift into a second
   * opinion about what attendance freshness means.
   *
   * Returns the marker keys that moved, or an empty list.
   */
  /**
   * IS THE MONTHLY ATTENDANCE THIS CALCULATION PRICED STILL THE CURRENT ONE,
   * AND IS IT CURRENT WITH ITS DAYS? Asked on the held payrun-row lock, with
   * LOCKING reads (`LOCK IN SHARE MODE`), because Approve & Lock approves many
   * employees in one transaction and a plain read would answer from the
   * snapshot taken at the first of them - not from what is committed now.
   *
   *   1. The summary's identity (id, version, calculated_at) must be the one
   *      the calculation recorded - else SOURCE_MOVED, as the source check.
   *   2. The summary's day fingerprint must match the stored day rows as they
   *      stand - else ATTENDANCE_STALE: a day moved (a permission, an
   *      approval, a void, a daily recalculation) since the month was
   *      persisted, so the summary still carries the old shortage or OT.
   *      A summary with no fingerprint predates this check and is STALE.
   *
   * Returns null when the month may lock, or the outcome that refuses it.
   * Every attendance writer takes this same payrun row FOR UPDATE before it
   * writes, and waits while it is held here, so nothing can move between
   * this answer and the status change.
   */
  async _attendanceFreshnessLocked(conn, { year, month, employee_id, stored }) {
    const mark = (v) => (v === null || v === undefined || v === "" ? "" : String(v));
    const [monthly] = await this._read(
      "LOCK-ATTENDANCE-MONTH",
      `SELECT attendance_monthly_payroll_id, payroll_version,
              DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS calculated_at,
              day_rows_fingerprint
         FROM attendance_monthly_payroll
        WHERE employee_id = ? AND period_year = ? AND period_month = ?
        LOCK IN SHARE MODE`,
      [employee_id, year, month],
      conn
    );
    const current = monthly || {};
    const moved = [
      ["attendance_monthly_payroll_id", current.attendance_monthly_payroll_id],
      ["attendance_payroll_version", current.payroll_version],
      ["attendance_calculated_at", current.calculated_at],
    ]
      .filter(([key, value]) => mark(value) !== mark(stored && stored[key]))
      .map(([key]) => key);
    if (moved.length > 0) return { outcome: "SOURCE_MOVED", changed: moved };

    const { from, to } = monthWindow(Number(year), Number(month));
    const dayRows = await this._read(
      "LOCK-ATTENDANCE-DAYS",
      dayRowsSql("LOCK IN SHARE MODE"),
      [employee_id, from, to],
      conn
    );
    const verdict = monthFreshness({ monthly: monthly || null, dayRows: Array.isArray(dayRows) ? dayRows : [] });
    if (verdict.state === "STALE") return { outcome: "ATTENDANCE_STALE", reason: verdict.reason };
    return null;
  }

  async _attendanceSourceChangesLocked(conn, { year, month, employee_id, stored }) {
    const { from, to } = monthWindow(Number(year), Number(month));
    const [attendanceRows, nrmRows] = await Promise.all([
      this.listAttendanceMonths([employee_id], year, month, conn),
      this.listEffectiveNrm([employee_id], from, to, conn),
    ]);

    const attendance = (attendanceRows || [])[0] || {};
    const nrm = resolveEffectiveNrm(
      (nrmRows || []).map((r) => ({
        nrm_minutes: r.nrm_minutes,
        break_allowance_source: r.break_allowance_source,
        day_count: r.day_count,
        approved_ot_minutes: r.approved_ot_minutes,
      }))
    );

    // Only the attendance keys are built out; the salary, statutory and
    // coverage markers are left at their defaults because they are not what
    // this comparison asks about.
    const current = sourceMarkers({ attendance, nrm });
    return attendanceSourceChanges(stored, current);
  }

  /**
   * A WORK SHIFT RULE CHANGE THAT HAS NOT REACHED THIS MONTH YET.
   *
   * =========================================================== WHY =========
   *
   * A shift rule saved while a month is open must be propagated into that
   * month BEFORE payroll settles it. The propagation is deliberately
   * asynchronous - it can be hundreds of employee-months - and that opens a
   * race the lock itself cannot see:
   *
   *   1  the rule changes and commits, owing a QUEUED propagation
   *   2  the worker has not reached this employee's month yet
   *   3  Approve & Lock runs against the OLD stored attendance
   *   4  the month becomes APPROVED_LOCKED
   *   5  the worker arrives, is correctly refused by the payroll lock
   *   6  payroll is frozen forever on figures the rule change superseded
   *
   * Nothing downstream can repair 6: a locked month is settled by design. So
   * the approval must refuse to settle a month that is still owed a
   * recalculation.
   *
   * ==================================================== WHY IT IS HERE =====
   *
   * ON THE APPROVAL'S OWN CONNECTION, INSIDE ITS TRANSACTION, AFTER the row
   * is locked and BEFORE the status changes - beside the attendance-source
   * revalidation, for the same reason that one is here rather than in the
   * usecase: a check made before the transaction can be overtaken by the
   * thing it is checking for. `FOR UPDATE` on the unresolved runs is what
   * settles the two orderings against a Work Shift save committing at the
   * same moment:
   *
   *   save first       its QUEUED row is committed and visible; this read
   *                    finds it and the approval is refused
   *   approval first   the read holds the index range it scanned, so the
   *                    save's INSERT waits for this transaction to finish;
   *                    the rule change therefore lands AFTER the month was
   *                    locked, which is an ordinary settled month and
   *                    correctly skipped by the propagation
   *
   * And because no lock can be perfect against a path that does not take it,
   * the worker ALSO reports any month it finds locked after its own run was
   * queued (`usecase/attendance_calculation.js`), so a month settled on stale
   * attendance can never be a silent skip.
   *
   * ======================================================= UNRESOLVED ======
   *
   * QUEUED, RUNNING, FAILED and COMPLETED_WITH_ERRORS all mean "this rule
   * change may not have reached that month". Only COMPLETED is clear.
   *
   * ==================================================== EMPLOYEE-SPECIFIC ==
   *
   * An unresolved run blocks only the employees and months that shift
   * actually governs, answered by the SAME dated logic the propagation's own
   * scope comes from - `utils/shift_propagation.js#governsEmployeeMonth` over
   * that employee's assignment history, their overrides onto that shift and
   * their employment. Somebody who has never been on the edited shift is not
   * held up by it.
   *
   * THE COMMON CASE COSTS ONE INDEXED READ. With no unresolved propagation
   * anywhere - which is almost always - this returns after the first
   * statement and asks nothing else.
   */
  async _pendingShiftPropagationLocked(conn, { employee_id, year, month }) {
    const unresolved = await this._read(
      "LOCK-UNRESOLVED-SHIFT-PROPAGATIONS",
      `SELECT attendance_recalculation_run_id, work_shift_id, status
         FROM attendance_recalculation_run
        WHERE trigger_source = 'WORK_SHIFT_SAVE'
          AND status IN ('QUEUED', 'RUNNING', 'FAILED', 'COMPLETED_WITH_ERRORS')
        ORDER BY attendance_recalculation_run_id ASC
        FOR UPDATE`,
      [],
      conn
    );
    const runs = Array.isArray(unresolved) ? unresolved : [];
    if (runs.length === 0) return [];

    const shiftIds = [...new Set(runs.map((r) => Number(r.work_shift_id)).filter(Boolean))];
    if (shiftIds.length === 0) return [];

    // This employee's dated facts, on the same connection. One employee, so
    // three small indexed reads - and only when something is actually
    // unresolved.
    const [employment, assignments, overrides] = await Promise.all([
      this._read(
        "PENDING-PROPAGATION-EMPLOYMENT",
        `SELECT ne.employee_id, ne.attendance_required,
                DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS date_of_joining,
                DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date
           FROM new_employee ne
          WHERE ne.employee_id = ?`,
        [employee_id],
        conn
      ),
      this._read(
        "PENDING-PROPAGATION-ASSIGNMENTS",
        `SELECT employee_work_shift_assignment_id, employee_id, work_shift_id,
                DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from
           FROM employee_work_shift_assignment
          WHERE employee_id = ?
          ORDER BY effective_from ASC, employee_work_shift_assignment_id ASC`,
        [employee_id],
        conn
      ),
      this._read(
        "PENDING-PROPAGATION-OVERRIDES",
        `SELECT o.work_shift_id, DATE_FORMAT(o.attendance_date, '%Y-%m-%d') AS attendance_date
           FROM attendance_date_shift_override o
          WHERE o.employee_id = ? AND o.work_shift_id IN (?)
            AND ${activeOverrideCondition("o")}
          GROUP BY o.work_shift_id, o.attendance_date`,
        [employee_id, shiftIds],
        conn
      ),
    ]);

    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    const employee = (Array.isArray(employment) ? employment : [])[0] || null;
    const today = istToday();

    const blocking = [];
    runs.forEach((run) => {
      const workShiftId = Number(run.work_shift_id);
      if (!workShiftId) return;
      const governs = governsEmployeeMonth({
        employee,
        assignments: Array.isArray(assignments) ? assignments : [],
        overrideDates: (Array.isArray(overrides) ? overrides : [])
          .filter((o) => Number(o.work_shift_id) === workShiftId)
          .map((o) => o.attendance_date),
        workShiftId,
        month: monthKey,
        today,
      });
      if (governs) {
        blocking.push({
          run_id: Number(run.attendance_recalculation_run_id),
          work_shift_id: workShiftId,
          status: run.status,
        });
      }
    });
    return blocking;
  }

  async approve({ year, month, employees, approved_by = null, approved_by_user = null, mode = "INDIVIDUAL" }) {
    if (!Array.isArray(employees) || employees.length === 0) return [];
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const results = [];

      for (const entry of employees) {
        const current = await this._read(
          "LOCK-CALCULATION-ROW",
          `SELECT payrun_calculation_id, payrun_employee_id, employee_id, status,
                  calculation_hash, calculation_version, calculation_revision,
                  source_hash, net_pay,
                  attendance_monthly_payroll_id, attendance_payroll_version,
                  DATE_FORMAT(attendance_calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS attendance_calculated_at,
                  approved_ot_minutes, effective_nrm_minutes, effective_nrm_source,
                  ot_groups
             FROM payrun_employee_calculation
            WHERE period_year = ? AND period_month = ? AND employee_id = ?
            FOR UPDATE`,
          [year, month, entry.employee_id],
          conn
        );
        const row = current[0];

        if (!row) {
          results.push({ employee_id: entry.employee_id, outcome: "NO_CALCULATION" });
          continue;
        }
        if (row.status === STORED_STATUS.APPROVED_LOCKED) {
          results.push({ employee_id: entry.employee_id, outcome: "ALREADY_LOCKED" });
          continue;
        }
        if (entry.calculation_hash && entry.calculation_hash !== row.calculation_hash) {
          results.push({ employee_id: entry.employee_id, outcome: "CALCULATION_MOVED" });
          continue;
        }

        // THE AUTHORITATIVE SOURCE CHECK, after the row lock and before the
        // status changes. Nothing decided before this transaction is trusted.
        const movedKeys = await this._attendanceSourceChangesLocked(conn, {
          year,
          month,
          employee_id: row.employee_id,
          stored: row,
        });
        if (movedKeys.length > 0) {
          results.push({
            employee_id: entry.employee_id,
            outcome: "SOURCE_MOVED",
            changed: movedKeys,
          });
          continue;
        }

        // AND THE MONTHLY SUMMARY MUST BE CURRENT WITH ITS DAYS, on the same
        // held lock. A permission, an approval or a void rewrites DAYS; only
        // the month persist rewrites the summary this calculation priced.
        const freshness = await this._attendanceFreshnessLocked(conn, {
          year,
          month,
          employee_id: row.employee_id,
          stored: row,
        });
        if (freshness) {
          results.push({ employee_id: entry.employee_id, ...freshness });
          continue;
        }

        // AND THE PENDING SHIFT-RULE RECALCULATION, on the same held lock.
        // A month may not be settled while a rule change is still owed to it.
        const pending = await this._pendingShiftPropagationLocked(conn, {
          employee_id: row.employee_id,
          year,
          month,
        });
        if (pending.length > 0) {
          results.push({
            employee_id: entry.employee_id,
            outcome: "RECALCULATION_PENDING",
            pending_recalculations: pending,
          });
          continue;
        }

        // AND THE PRIOR-MONTH OT IT PAYS MUST STILL BE EXACTLY WHAT IT
        // CLAIMED, on the same held lock: an item revoked (CANCELLED) after
        // this calculation was saved must not be locked in as paid.
        if (await this._lateOtMovedLocked(conn, { row, year, month })) {
          results.push({ employee_id: entry.employee_id, outcome: "PRIOR_MONTH_OT_MOVED" });
          continue;
        }

        await this._read(
          "APPROVE-AND-LOCK",
          `UPDATE payrun_employee_calculation
              SET status = 'APPROVED_LOCKED',
                  approved_by = ?, approved_at = CURRENT_TIMESTAMP,
                  locked_by = ?,   locked_at   = CURRENT_TIMESTAMP
            WHERE payrun_calculation_id = ? AND status = 'CALCULATED'`,
          [approved_by, approved_by, row.payrun_calculation_id],
          conn
        );

        await this._read(
          "INSERT-APPROVAL-AUDIT",
          `INSERT INTO payrun_employee_calculation_audit
                  (payrun_employee_id, period_year, period_month, employee_id,
                   action, calculation_version, calculation_revision,
                   calculation_hash, source_hash, net_pay, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.payrun_employee_id,
            year,
            month,
            row.employee_id,
            AUDIT_ACTION.APPROVE_LOCK,
            row.calculation_version,
            row.calculation_revision,
            row.calculation_hash,
            row.source_hash,
            row.net_pay,
            approved_by,
          ],
          conn
        );

        // THE LIFECYCLE LOG, in the same transaction as the lock it records.
        await this._lifecycleAudit(conn, {
          row, year, month, action: AUDIT_ACTION_LIFECYCLE.LOCK,
          previous_status: STORED_STATUS.CALCULATED, new_status: STORED_STATUS.APPROVED_LOCKED,
          mode, employee_id_actor: approved_by, user_id_actor: approved_by_user,
        });

        // PENDING PERMISSION REQUESTS CLOSE WITH THE MONTH, in this same
        // transaction: once the row above is APPROVED_LOCKED no decision can
        // pay them, so none may go on claiming to be pending. They become
        // "Closed - Not approved before payroll lock", exactly as the OT
        // closure shapes a closed claim. Approved, rejected and revoked
        // requests, and DIRECT grants, are untouched.
        const permissionClosure = await closePendingPermissionsForLock(conn, {
          employee_id: row.employee_id,
          year,
          month,
        });

        // PRIOR-MONTH OT THIS MONTH INCLUDED IS NOW PAID: SETTLED, in the
        // same transaction as the lock, and never again claimable.
        const lateOtSettled = await moveLateOt(conn, this, {
          employee_id: row.employee_id,
          year,
          month,
          from: "INCLUDED",
          to: "SETTLED",
          actor: approved_by,
          note: "settled: payroll approved and locked",
        });

        results.push({
          employee_id: entry.employee_id,
          outcome: "APPROVED",
          calculation_hash: row.calculation_hash,
          net_pay: row.net_pay,
          permissions_closed: permissionClosure.closed,
          prior_month_ot_settled: lateOtSettled,
        });
      }

      await commitAsync(conn);
      return results;
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * RESET ONE EMPLOYEE'S CALCULATION - the row goes, everything else stays.
   *
   * "Not Calculated" IS the absence of a row here, so returning an employee to
   * it means removing exactly one: the row for THIS year, THIS month and THIS
   * employee. Nothing references it by foreign key, so the removal cascades
   * nowhere, and there is no statement in this method that names any other
   * table except the reset audit it writes.
   *
   * ONE TRANSACTION PER EMPLOYEE, deliberately unlike `approve`. A bulk reset
   * that met one locked employee must still reset the other nine, and an
   * employee half reset - row gone, audit missing - must be impossible. So each
   * employee commits or rolls back on its own, and the caller loops.
   *
   * THE SAME ROW LOCK APPROVAL AND ATTENDANCE TAKE. The row is located by its
   * identity and locked `FOR UPDATE` before its status is read, so:
   *
   *   approval first   it locks and approves; this wakes, sees
   *                    APPROVED_LOCKED and refuses
   *   reset first      it locks and deletes; the approval wakes, finds no
   *                    row and reports NO_CALCULATION
   *
   * THE DELETE IS AN ALLOW-LIST. It carries `AND status = 'CALCULATED'`, so a
   * locked row - or any stored status added later, a paid or published one -
   * cannot be removed even by a caller that skipped every check above it. And
   * if it removes anything other than exactly one row the whole employee rolls
   * back.
   *
   * THE MONTH LOCK IS RE-READ INSIDE THE TRANSACTION, so a month locked after
   * the usecase looked is still refused.
   *
   * THE REMOVED ROW IS KEPT, IN FULL, ON THE AUDIT. It is re-read through
   * `listCalculations` on this connection after the lock - the same statement,
   * the same DATE_FORMATs - so the snapshot reads exactly as the screen did.
   *
   * IDEMPOTENT: a second reset of the same employee finds no row and answers
   * NOT_CALCULATED, writing nothing.
   */
  async resetCalculation({
    year,
    month,
    employee_id,
    previous_status,
    reason,
    remark = null,
    mode,
    reset_by = null,
  }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);

      const [periodRow] = await this._read(
        "RESET-LOCK-PERIOD",
        `SELECT status FROM payrun_period
          WHERE period_year = ? AND period_month = ?
          LOCK IN SHARE MODE`,
        [year, month],
        conn
      );
      if (periodRow && periodRow.status === "LOCKED") {
        await rollbackAsync(conn);
        return { employee_id, outcome: "MONTH_LOCKED" };
      }

      // NO STATUS IN THE PREDICATE: locate by identity, lock, then inspect.
      const [locked] = await this._read(
        "RESET-LOCK-CALCULATION-ROW",
        `SELECT payrun_calculation_id, status
           FROM payrun_employee_calculation
          WHERE period_year = ? AND period_month = ? AND employee_id = ?
          FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (!locked) {
        await rollbackAsync(conn);
        return { employee_id, outcome: "NOT_CALCULATED" };
      }
      if (locked.status !== STORED_STATUS.CALCULATED) {
        await rollbackAsync(conn);
        return { employee_id, outcome: "LOCKED", stored_status: locked.status };
      }

      const [stored] = await this.listCalculations(
        { year, month, employee_ids: [employee_id] },
        conn
      );

      await this._read(
        "INSERT-RESET-AUDIT",
        `INSERT INTO payrun_employee_calculation_reset_audit
                (payrun_employee_id, period_year, period_month, employee_id,
                 payrun_calculation_id, previous_status, previous_stored_status,
                 reset_reason, reset_remark, reset_mode,
                 calculation_version, calculation_revision, calculation_hash,
                 source_hash, inputs_hash, net_pay, calculation_snapshot, reset_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stored.payrun_employee_id,
          year,
          month,
          employee_id,
          stored.payrun_calculation_id,
          previous_status || stored.status,
          stored.status,
          reason,
          remark,
          mode,
          stored.calculation_version,
          stored.calculation_revision,
          stored.calculation_hash,
          stored.source_hash,
          stored.inputs_hash,
          stored.net_pay,
          JSON.stringify(stored),
          reset_by,
        ],
        conn
      );

      const deleted = await this._read(
        "RESET-DELETE-CALCULATION",
        `DELETE FROM payrun_employee_calculation
          WHERE payrun_calculation_id = ?
            AND period_year = ? AND period_month = ? AND employee_id = ?
            AND status = 'CALCULATED'`,
        [stored.payrun_calculation_id, year, month, employee_id],
        conn
      );
      if (!deleted || Number(deleted.affectedRows) !== 1) {
        throw new Error(
          `Reset removed ${deleted ? deleted.affectedRows : "no"} rows for employee ${employee_id}; rolled back`
        );
      }
      // The month no longer has a calculation, so it no longer holds any
      // prior-month OT: released back to PENDING_SETTLEMENT for the next
      // calculation (of this month or a later one) to claim.
      await moveLateOt(conn, this, {
        employee_id, year, month, from: "INCLUDED", to: "PENDING_SETTLEMENT",
        actor: reset_by, note: "released: payroll calculation reset",
      });

      await commitAsync(conn);
      return {
        employee_id,
        outcome: "RESET",
        payrun_calculation_id: stored.payrun_calculation_id,
        net_pay: stored.net_pay,
      };
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /** One append-only lifecycle row, on the caller's connection and transaction. */
  async _lifecycleAudit(conn, {
    row, year, month, action, previous_status, new_status, reason = null, remark = null,
    mode, employee_id_actor = null, user_id_actor = null, payslip_id = null,
  }) {
    await this._read(
      "INSERT-LIFECYCLE-AUDIT",
      `INSERT INTO payrun_employee_lifecycle_audit
              (payrun_employee_id, payrun_calculation_id, period_year, period_month, employee_id,
               action, previous_status, new_status, reason, remark, mode,
               calculation_hash, net_pay, acted_by_employee_id, acted_by_user_id, payslip_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.payrun_employee_id, row.payrun_calculation_id, year, month, row.employee_id,
        action, previous_status, new_status, reason, remark, mode,
        row.calculation_hash, row.net_pay, employee_id_actor, user_id_actor, payslip_id,
      ],
      conn
    );
  }

  /**
   * UNLOCK / PUBLISH / UNPUBLISH - one employee, one transaction.
   *
   * THE SAME DISCIPLINE AS APPROVE AND RESET: the month lock is re-read inside
   * the transaction, the row is found by identity and locked `FOR UPDATE`
   * before its state is inspected (so it serializes with Approve & Lock, with
   * every attendance writer and with Reset), the UPDATE repeats the expected
   * state in its WHERE clause, and exactly one row must move or the employee
   * rolls back. The lifecycle audit row commits with the change or not at all.
   *
   *   UNLOCK     APPROVED_LOCKED and NOT published -> CALCULATED. Every figure
   *              stays; the current approval and lock are cleared (the old
   *              approval stays in both audit logs) and the unlock is recorded.
   *   PUBLISH    APPROVED_LOCKED and not published -> published. The stored
   *              status does not change, so every lock still holds. Refused if
   *              the attendance it was priced from has moved or is not
   *              current with its days (the same re-reads Approve makes).
   *              PUBLISH IS PUBLISH PAYSLIP: the frozen snapshot `payslip`
   *              (built by the usecase from this same stored row) is inserted
   *              in this transaction, and refused unless it names the row's
   *              calculation id and calculation hash as they are under the
   *              lock - so a snapshot can never describe figures other than
   *              the ones being published. A republish is a new version.
   *   UNPUBLISH  published -> APPROVED_LOCKED (published_* cleared), and the
   *              ACTIVE payslip is ARCHIVED - kept, never deleted, and gone
   *              from the Mini App at commit.
   */
  async lifecycle({ action, year, month, employee_id, reason = null, remark = null, mode, actor = {}, payslip = null }) {
    const actorEmployee = actor.employeeId === undefined ? null : actor.employeeId;
    const actorUser = actor.userId === undefined ? null : actor.userId;
    const conn = await getConnectionAsync(this.db);
    const done = async (outcome, extra = {}) => {
      await rollbackAsync(conn);
      return { employee_id, outcome, ...extra };
    };
    try {
      await beginTransactionAsync(conn);

      const [periodRow] = await this._read(
        "LIFECYCLE-LOCK-PERIOD",
        `SELECT status FROM payrun_period WHERE period_year = ? AND period_month = ? LOCK IN SHARE MODE`,
        [year, month],
        conn
      );
      if (periodRow && periodRow.status === "LOCKED") return done("MONTH_LOCKED");

      const [row] = await this._read(
        "LIFECYCLE-LOCK-ROW",
        `SELECT payrun_calculation_id, payrun_employee_id, employee_id, status, published_at,
                calculation_hash, net_pay, source_hash, inputs_hash,
                calculation_version, calculation_revision,
                attendance_monthly_payroll_id, attendance_payroll_version,
                DATE_FORMAT(attendance_calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS attendance_calculated_at,
                approved_ot_minutes, effective_nrm_minutes, effective_nrm_source, ot_groups
           FROM payrun_employee_calculation
          WHERE period_year = ? AND period_month = ? AND employee_id = ?
          FOR UPDATE`,
        [year, month, employee_id],
        conn
      );
      if (!row) return done("NOT_CALCULATED");
      const locked = row.status === STORED_STATUS.APPROVED_LOCKED;
      const published = locked && row.published_at !== null && row.published_at !== undefined;
      const previous = published ? CALC_STATUS.PUBLISHED : locked ? CALC_STATUS.APPROVED_LOCKED : row.status;

      let update;
      let next;
      let payslipId = null;
      if (action === AUDIT_ACTION_LIFECYCLE.UNLOCK) {
        if (published) return done("PUBLISHED");
        if (!locked) return done("NOT_LOCKED");
        update = [
          `UPDATE payrun_employee_calculation
              SET status = 'CALCULATED',
                  approved_by = NULL, approved_at = NULL,
                  locked_by = NULL, locked_at = NULL,
                  unlocked_by = ?, unlocked_at = CURRENT_TIMESTAMP, unlock_reason = ?
            WHERE payrun_calculation_id = ? AND status = 'APPROVED_LOCKED' AND published_at IS NULL`,
          [actorEmployee, reason, row.payrun_calculation_id],
        ];
        next = STORED_STATUS.CALCULATED;
      } else if (action === AUDIT_ACTION_LIFECYCLE.PUBLISH) {
        if (published) return done("ALREADY_PUBLISHED");
        if (!locked) return done("NOT_LOCKED");
        const moved = await this._attendanceSourceChangesLocked(conn, { year, month, employee_id, stored: row });
        if (moved.length > 0) return done("SOURCE_MOVED", { changed: moved });
        const freshness = await this._attendanceFreshnessLocked(conn, { year, month, employee_id, stored: row });
        if (freshness) return done(freshness.outcome, { reason: freshness.reason });
        if (!payslip || !payslip.text || !payslip.sha256) {
          throw new Error("PUBLISH requires a frozen payslip snapshot");
        }
        if (
          Number(payslip.payrun_calculation_id) !== Number(row.payrun_calculation_id) ||
          String(payslip.calculation_hash) !== String(row.calculation_hash)
        ) {
          return done("CALCULATION_CHANGED");
        }
        update = [
          `UPDATE payrun_employee_calculation
              SET published_by = ?, published_at = CURRENT_TIMESTAMP
            WHERE payrun_calculation_id = ? AND status = 'APPROVED_LOCKED' AND published_at IS NULL`,
          [actorEmployee, row.payrun_calculation_id],
        ];
        next = CALC_STATUS.PUBLISHED;
      } else if (action === AUDIT_ACTION_LIFECYCLE.UNPUBLISH) {
        if (!published) return done(locked ? "NOT_PUBLISHED" : "NOT_LOCKED");
        const [activeSlip] = await this._read(
          "UNPUBLISH-LOCK-PAYSLIP",
          `SELECT payslip_id FROM payrun_payslip
            WHERE payrun_employee_id = ? AND status = 'ACTIVE'
            FOR UPDATE`,
          [row.payrun_employee_id],
          conn
        );
        payslipId = activeSlip ? activeSlip.payslip_id : null;
        update = [
          `UPDATE payrun_employee_calculation
              SET published_by = NULL, published_at = NULL
            WHERE payrun_calculation_id = ? AND status = 'APPROVED_LOCKED' AND published_at IS NOT NULL`,
          [row.payrun_calculation_id],
        ];
        next = CALC_STATUS.APPROVED_LOCKED;
      } else {
        throw new Error(`Unknown lifecycle action ${action}`);
      }

      const moved = await this._read(`LIFECYCLE-${action}`, update[0], update[1], conn);
      if (!moved || Number(moved.affectedRows) !== 1) {
        throw new Error(`${action} moved ${moved ? moved.affectedRows : "no"} rows for employee ${employee_id}; rolled back`);
      }
      if (action === AUDIT_ACTION_LIFECYCLE.PUBLISH) {
        payslipId = await this._insertPayslip(conn, { row, year, month, payslip, actorEmployee, actorUser });
        // THE OUTBOX: attempt 1 is queued in this transaction, so a committed
        // publication always has its notification queued and a rolled-back
        // one never does. The worker sends it; this request never waits.
        await this._read(
          "QUEUE-PUBLISH-NOTIFICATION",
          `INSERT INTO payrun_payslip_notification
                  (payslip_id, employee_id, attempt_no, trigger_type, result, requested_by, requested_by_user)
           VALUES (?, ?, 1, 'PUBLISH', 'QUEUED', ?, ?)`,
          [payslipId, row.employee_id, actorEmployee, actorUser],
          conn
        );
      } else if (action === AUDIT_ACTION_LIFECYCLE.UNPUBLISH && payslipId !== null) {
        const archived = await this._read(
          "UNPUBLISH-ARCHIVE-PAYSLIP",
          `UPDATE payrun_payslip
              SET status = 'ARCHIVED', archived_by = ?, archived_by_user = ?,
                  archived_at = CURRENT_TIMESTAMP, archive_reason = ?
            WHERE payslip_id = ? AND status = 'ACTIVE'`,
          [actorEmployee, actorUser, reason, payslipId],
          conn
        );
        if (!archived || Number(archived.affectedRows) !== 1) {
          throw new Error(`UNPUBLISH could not archive payslip ${payslipId}; rolled back`);
        }
        // A notification still waiting in the queue is withdrawn with it: an
        // employee is never told about a payslip that is no longer there.
        await this._read(
          "UNPUBLISH-CANCEL-QUEUED-NOTIFICATION",
          `UPDATE payrun_payslip_notification
              SET result = 'FAILED', failure_code = 'PAYSLIP_UNPUBLISHED',
                  failure_reason = 'Withdrawn: the payslip was unpublished before it was sent',
                  completed_at = CURRENT_TIMESTAMP(3)
            WHERE payslip_id = ? AND result = 'QUEUED'`,
          [payslipId],
          conn
        );
      }
      await this._lifecycleAudit(conn, {
        row, year, month, action, previous_status: previous, new_status: next,
        reason, remark, mode, employee_id_actor: actorEmployee, user_id_actor: actorUser,
        payslip_id: payslipId,
      });
      if (action === AUDIT_ACTION_LIFECYCLE.UNLOCK) {
        // An unlocked month is not paid yet: its prior-month OT goes back
        // from SETTLED to INCLUDED with it (a re-lock settles it again).
        await moveLateOt(conn, this, {
          employee_id: row.employee_id, year, month, from: "SETTLED", to: "INCLUDED",
          actor: actorEmployee, note: "payroll month unlocked",
        });
        // The calculation history's own UNLOCK verb, reserved for this.
        await this._read(
          "INSERT-UNLOCK-CALCULATION-AUDIT",
          `INSERT INTO payrun_employee_calculation_audit
                  (payrun_employee_id, period_year, period_month, employee_id, action,
                   calculation_hash, net_pay, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.payrun_employee_id, year, month, row.employee_id, AUDIT_ACTION.UNLOCK,
            row.calculation_hash, row.net_pay, actorEmployee],
          conn
        );
      }
      await commitAsync(conn);
      return {
        employee_id, outcome: action, previous_status: previous, new_status: next, net_pay: row.net_pay,
        payslip_id: payslipId,
      };
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * THE FROZEN SNAPSHOT, inserted inside the Publish transaction. The version
   * is the next one for this employee month, read under the calculation row's
   * lock (which every Publish of this employee month takes first), and the
   * published time is the calculation row's own, so the two always agree.
   */
  async _insertPayslip(conn, { row, year, month, payslip, actorEmployee, actorUser }) {
    // A plain (non-locking) read: every Publish of this employee month holds
    // the calculation row FOR UPDATE first, so they are already serialized
    // and this sees the last committed version. An INSERT ... SELECT MAX would
    // take gap locks on payrun_payslip and could deadlock two publishers of
    // DIFFERENT employees. The unique (payrun_employee_id, payslip_version)
    // key is the backstop: a duplicate rolls this employee back, never two
    // payslips with one version.
    const [last] = await this._read(
      "NEXT-PAYSLIP-VERSION",
      "SELECT COALESCE(MAX(payslip_version), 0) AS v FROM payrun_payslip WHERE payrun_employee_id = ?",
      [row.payrun_employee_id],
      conn
    );
    const res = await this._read(
      "INSERT-PAYSLIP",
      `INSERT INTO payrun_payslip
              (payslip_ref, payrun_employee_id, payrun_calculation_id, employee_id,
               period_year, period_month, payslip_version,
               calculation_version, calculation_revision, calculation_hash, source_hash, inputs_hash,
               snapshot_schema_version, template_version, snapshot_json, snapshot_sha256,
               status, published_by, published_by_user, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, c.published_at
         FROM payrun_employee_calculation c
        WHERE c.payrun_calculation_id = ?`,
      [
        payslip.payslip_ref, row.payrun_employee_id, row.payrun_calculation_id, row.employee_id,
        year, month, Number(last.v) + 1,
        row.calculation_version, row.calculation_revision, row.calculation_hash,
        row.source_hash, row.inputs_hash,
        payslip.schema_version, payslip.template_version, payslip.text, payslip.sha256,
        actorEmployee, actorUser, row.payrun_calculation_id,
      ],
      conn
    );
    if (!res || Number(res.affectedRows) !== 1) {
      throw new Error(`PUBLISH could not store the payslip for employee ${row.employee_id}; rolled back`);
    }
    return res.insertId;
  }

  /** One employee's lifecycle history for the month, newest first. */
  async listLifecycleAudit({ year, month, employee_id }) {
    return this._read(
      "LIST-LIFECYCLE-AUDIT",
      `SELECT payrun_lifecycle_audit_id, action, previous_status, new_status, reason, remark, mode,
              calculation_hash, net_pay, acted_by_employee_id, acted_by_user_id, payslip_id,
              DATE_FORMAT(acted_at, '%Y-%m-%d %H:%i:%s') AS acted_at
         FROM payrun_employee_lifecycle_audit
        WHERE period_year = ? AND period_month = ? AND employee_id = ?
        ORDER BY payrun_lifecycle_audit_id DESC`,
      [year, month, employee_id]
    );
  }

  /** One employee's reset history for the month, newest first. */
  async listResetAudit({ year, month, employee_id }) {
    return this._read(
      "LIST-RESET-AUDIT",
      `SELECT payrun_calculation_reset_audit_id, payrun_calculation_id,
              previous_status, previous_stored_status,
              reset_reason, reset_remark, reset_mode,
              calculation_version, calculation_revision, calculation_hash, net_pay,
              reset_by,
              DATE_FORMAT(reset_at, '%Y-%m-%d %H:%i:%s') AS reset_at
         FROM payrun_employee_calculation_reset_audit
        WHERE period_year = ? AND period_month = ? AND employee_id = ?
        ORDER BY payrun_calculation_reset_audit_id DESC`,
      [year, month, employee_id]
    );
  }
}

module.exports = (db) => new PayrunCalculationRepository(db);
module.exports.PayrunCalculationRepository = PayrunCalculationRepository;
