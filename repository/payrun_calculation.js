const logger = require("../utils/logger");
const { activeOverrideCondition } = require("../utils/shift_override_active");
const { JOINED_ON } = require("../utils/joining_date");
const {
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { locationPredicate } = require("./payrun");
const { monthWindow } = require("../utils/payrun_eligibility");
const { AUDIT_ACTION, STORED_STATUS } = require("../constants/payrun_calculation");
const {
  resolveEffectiveNrm,
  sourceMarkers,
  attendanceSourceChanges,
} = require("../utils/payrun_calculation");
const { governsEmployeeMonth } = require("../utils/shift_propagation");
const { istToday } = require("../utils/istDate");

/**
 * Payrun Calculation & Review - the reads a calculated month needs, and the
 * three writes that calculate, recalculate and lock one.
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
 * IT NEVER WRITES OUTSIDE ITS OWN TWO TABLES. There is no UPDATE of
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
class PayrunCalculationRepository {
  constructor(db) {
    this.db = db;
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
    return this._read(
      "LIST-ATTENDANCE-MONTHS",
      `SELECT attendance_monthly_payroll_id, employee_id, is_final, payroll_version,
              salary_days, extra_days, base_days,
              monthly_gross, daily_rate,
              salary_day_earnings, extra_day_earnings,
              shortage_minutes, missing_minute_deduction,
              approved_ot_minutes, approved_ot_earnings,
              DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s.%f') AS calculated_at
         FROM attendance_monthly_payroll
        WHERE employee_id IN (?) AND period_year = ? AND period_month = ?`,
      [employeeIds, year, month],
      conn
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
      `SELECT employee_id,
              nrm_minutes,
              break_allowance_source,
              COUNT(*) AS day_count,
              SUM(approved_ot_minutes) AS approved_ot_minutes
         FROM attendance_day_calculation
        WHERE employee_id IN (?)
          AND attendance_date >= ? AND attendance_date <= ?
          AND is_final = 1
          AND nrm_minutes > 0
        GROUP BY employee_id, nrm_minutes, break_allowance_source
        ORDER BY employee_id`,
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
              ne.pf_applicable,
              ne.esi_applicable,
              ne.previous_eps_member,
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
              incentive, bonus, arrears, advance_recovery, shortage_recovery,
              balance_advance,
              pf_status, pf_wage, employee_pf, employer_pf_total, employer_epf, employer_eps,
              esi_status, esi_wage, esi_wage_basis, employee_esi, employer_esi,
              DATE_FORMAT(esi_period_start, '%Y-%m-%d') AS esi_period_start,
              DATE_FORMAT(esi_period_end, '%Y-%m-%d')   AS esi_period_end,
              DATE_FORMAT(esi_coverage_entry_date, '%Y-%m-%d') AS esi_coverage_entry_date,
              esi_coverage_entry_salary_id, esi_coverage_entry_gross, esi_coverage_basis,
              esi_contribution_period_continues,
              total_earnings, total_employee_deductions, net_pay, pay_type,
              unresolved, errors, is_complete,
              calculation_version, calculation_revision, calculation_hash,
              DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s') AS calculated_at,
              calculated_by,
              status,
              approved_by, DATE_FORMAT(approved_at, '%Y-%m-%d %H:%i:%s') AS approved_at,
              locked_by,   DATE_FORMAT(locked_at,   '%Y-%m-%d %H:%i:%s') AS locked_at
         FROM payrun_employee_calculation
        WHERE ${clause}
        ORDER BY employee_id`,
      params,
      conn
    );
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
      "incentive", "bonus", "arrears", "advance_recovery", "shortage_recovery",
      "balance_advance",
      "pf_status", "pf_wage", "employee_pf", "employer_pf_total",
      "employer_epf", "employer_eps",
      "esi_status", "esi_wage", "esi_wage_basis", "employee_esi", "employer_esi",
      "esi_period_start", "esi_period_end", "esi_coverage_entry_date",
      "esi_coverage_entry_salary_id", "esi_coverage_entry_gross", "esi_coverage_basis",
      "esi_contribution_period_continues",
      "total_earnings", "total_employee_deductions", "net_pay", "pay_type",
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

  async approve({ year, month, employees, approved_by = null }) {
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

        results.push({
          employee_id: entry.employee_id,
          outcome: "APPROVED",
          calculation_hash: row.calculation_hash,
          net_pay: row.net_pay,
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
}

module.exports = (db) => new PayrunCalculationRepository(db);
module.exports.PayrunCalculationRepository = PayrunCalculationRepository;
