const logger = require("../utils/logger");
const { locationPredicate } = require("./payrun");

/**
 * Payroll Dashboard - the three reads the dashboard needs that no payrun
 * repository already makes. Everything else (the population, the snapshots,
 * the statuses and the figures) comes through the payrun usecases unchanged.
 *
 * READ ONLY. Every statement is batched across the month and takes the
 * location predicate from `repository/payrun.js`, with its fail-closed
 * meaning: `null` is company-wide, `[]` is nobody.
 */
class PayrollDashboardRepository {
  constructor(db) {
    this.db = db;
  }

  _read(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PAYROLL_DASHBOARD",
            code: `REPOSITORY.PAYROLL_DASHBOARD.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * THE MONTH STRIP: per payroll month in [from, to] (each `{year, month}`),
   * how many employees are initialized, calculated, approved and published,
   * and the stored gross of the calculated ones. Stored state only - the
   * month strip is a progress view, not a review; the derived statuses are
   * the summary's job.
   *
   * Location, department and designation are the SNAPSHOT's, which is how
   * Calculation & Review attributes an initialized employee.
   */
  async listMonthTotals({ from, to, store_ids = null, department_id = null, designation_id = null }) {
    /*
     * A financial year spans two calendar years. The bare `period_year`
     * range lets MySQL use `idx_payrun_employee_month (period_year,
     * period_month)`; the composite comparison then trims April-March. An
     * expression alone over the two columns could not use the index.
     */
    const where = [
      "pe.period_year BETWEEN ? AND ?",
      "(pe.period_year * 100 + pe.period_month) BETWEEN ? AND ?",
    ];
    const params = [from.year, to.year, from.year * 100 + from.month, to.year * 100 + to.month];
    const location = locationPredicate("pe.store_id", store_ids);
    if (location.clause) {
      where.push(location.clause);
      params.push(...location.params);
    }
    if (department_id !== null && department_id !== undefined) {
      where.push("pe.department_id = ?");
      params.push(department_id);
    }
    if (designation_id !== null && designation_id !== undefined) {
      where.push("pe.designation_id = ?");
      params.push(designation_id);
    }
    const rows = await this._read(
      "LIST-MONTH-TOTALS",
      `SELECT pe.period_year, pe.period_month,
              COUNT(*) AS initialized,
              COALESCE(SUM(c.payrun_employee_id IS NOT NULL), 0) AS calculated,
              COALESCE(SUM(c.status = 'APPROVED_LOCKED'), 0) AS approved,
              COALESCE(SUM(c.status = 'APPROVED_LOCKED' AND c.published_at IS NOT NULL), 0) AS published,
              COALESCE(SUM(c.total_earnings), 0) AS gross
         FROM payrun_employee pe
         LEFT JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
        WHERE ${where.join(" AND ")}
        GROUP BY pe.period_year, pe.period_month
        ORDER BY pe.period_year, pe.period_month`,
      params
    );
    return rows.map((r) => ({
      year: Number(r.period_year),
      month: Number(r.period_month),
      initialized: Number(r.initialized),
      calculated: Number(r.calculated),
      approved: Number(r.approved),
      published: Number(r.published),
      gross: r.gross === null ? null : String(r.gross),
    }));
  }

  /**
   * THE EMPLOYEE MASTER'S LIVE FACTS the payrun rows do not carry: the
   * department (and its name) and the employment type. Read for the month's
   * population only - never a wider set than the scoped usecases returned.
   */
  async listEmployeeFacts(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-EMPLOYEE-FACTS",
      `SELECT ne.employee_id, ne.department_id, dep.department_name, ne.employment_type
         FROM new_employee ne
         LEFT JOIN department dep ON dep.department_id = ne.department_id
        WHERE ne.employee_id IN (?)`,
      [employeeIds]
    );
  }

  /**
   * THE EMPLOYMENT PERIODS THAT OPENED OR CLOSED IN THE WINDOW - the dated
   * history of joins, exits and rejoins.
   *
   * WHY THE PERIOD TABLE AND NOT ONLY `new_employee`. The master keeps the
   * LATEST spell: a rejoin (`employee_master.markRejoined`) overwrites
   * `date_of_joining` and clears `resignation_date`, so an August exit
   * followed by a November rejoin is invisible in the master by December.
   * `employee_employment_period` keeps every spell; the Rejoin action opens
   * a new period in the same transaction (or rolls back), so a rejoin made
   * in DnDS is always here. Rejoins that pre-date the lifecycle backfill
   * were never recorded as such and read as period 1.
   */
  async listPeriodsInWindow(employeeIds, from, to) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-PERIODS-IN-WINDOW",
      `SELECT employee_id, period_no,
              DATE_FORMAT(joined_on, '%Y-%m-%d') AS joined_on,
              DATE_FORMAT(ended_on, '%Y-%m-%d')  AS ended_on
         FROM employee_employment_period
        WHERE employee_id IN (?)
          AND ((joined_on BETWEEN ? AND ?) OR (ended_on BETWEEN ? AND ?))`,
      [employeeIds, from, to, from, to]
    );
  }
}

module.exports = (db) => new PayrollDashboardRepository(db);
module.exports.PayrollDashboardRepository = PayrollDashboardRepository;
