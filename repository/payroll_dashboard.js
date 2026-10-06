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
    const where = ["(pe.period_year * 100 + pe.period_month) BETWEEN ? AND ?"];
    const params = [from.year * 100 + from.month, to.year * 100 + to.month];
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
   * WHO REJOINED IN THE WINDOW: an employment period after the first one
   * (`period_no > 1`) that opened inside it. The lifecycle period table is the
   * one place a rejoin is recorded as such - `new_employee` only keeps the
   * latest joining date.
   */
  async listRejoins(employeeIds, from, to) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-REJOINS",
      `SELECT employee_id, DATE_FORMAT(joined_on, '%Y-%m-%d') AS joined_on
         FROM employee_employment_period
        WHERE employee_id IN (?)
          AND period_no > 1
          AND joined_on BETWEEN ? AND ?`,
      [employeeIds, from, to]
    );
  }
}

module.exports = (db) => new PayrollDashboardRepository(db);
module.exports.PayrollDashboardRepository = PayrollDashboardRepository;
