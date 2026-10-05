const logger = require("../utils/logger");
const { locationPredicate } = require("./payrun");
const { parseJson } = require("./report_template");

/**
 * Payroll Reports - the reads, and the two small preference tables.
 *
 * It READS the payrun's tables and never writes them. The report SQL itself
 * is built in `utils/payroll_report_query.js` from catalogue text and only
 * executed here; this file adds no WHERE clause of its own to a report.
 *
 * It OWNS two tables (migration 20261123120000-payroll-reports):
 *
 *   payroll_report_layout            the columns one user chose for one report
 *                                    type in one payroll month
 *   payroll_report_default_template  the template one user wants a report
 *                                    type to open with, when the month has no
 *                                    layout of its own
 *
 * Neither stores a payroll value. Templates themselves live in the existing
 * `report_template` table (repository/report_template.js).
 */
class PayrollReportRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.PAYROLL_REPORT",
      code: `REPOSITORY.PAYROLL_REPORT.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  query(sql, params, code = "QUERY") {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ---------------------------------------------------------------- months */

  /**
   * Months with at least one finalized (approved & locked) employee, inside
   * the caller's branch scope, newest first - with how many of the month's
   * payrun employees are finalized, so a part-approved month says so.
   */
  async listMonths(store_ids) {
    const location = locationPredicate("pe.store_id", store_ids);
    const rows = await this.query(
      `SELECT pe.period_year, pe.period_month,
              COUNT(*) AS payrun_employees,
              SUM(c.status = 'APPROVED_LOCKED') AS finalized,
              SUM(c.status = 'APPROVED_LOCKED' AND c.published_at IS NOT NULL) AS published
         FROM payrun_employee pe
         LEFT JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
        ${location.clause ? `WHERE ${location.clause}` : ""}
        GROUP BY pe.period_year, pe.period_month
       HAVING finalized > 0
        ORDER BY pe.period_year DESC, pe.period_month DESC`,
      location.params,
      "LIST-MONTHS"
    );
    return rows.map((r) => ({
      year: Number(r.period_year),
      month: Number(r.period_month),
      payrun_employees: Number(r.payrun_employees),
      finalized: Number(r.finalized),
      published: Number(r.published),
    }));
  }

  /**
   * THE PAYRUN'S OWN TOTALS for a month and scope - the reconciliation
   * reference for the Payroll Register. Read straight from the payrun tables
   * with its own SQL, deliberately NOT through the report query builder, so
   * the two are independent answers that must agree.
   */
  async payrunTotals({ year, month, store_ids }) {
    const location = locationPredicate("pe.store_id", store_ids);
    const rows = await this.query(
      `SELECT COUNT(*) AS employees,
              COALESCE(SUM(c.status = 'APPROVED_LOCKED'), 0) AS finalized,
              COALESCE(SUM(CASE WHEN c.status = 'APPROVED_LOCKED' THEN c.total_earnings END), 0) AS gross,
              COALESCE(SUM(CASE WHEN c.status = 'APPROVED_LOCKED' THEN c.total_employee_deductions END), 0) AS deductions,
              COALESCE(SUM(CASE WHEN c.status = 'APPROVED_LOCKED' THEN c.net_pay END), 0) AS net_pay
         FROM payrun_employee pe
         LEFT JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
        WHERE pe.period_year = ? AND pe.period_month = ?
          ${location.clause ? `AND ${location.clause}` : ""}`,
      [year, month, ...location.params],
      "PAYRUN-TOTALS"
    );
    const r = rows[0] || {};
    const money = (v) => Math.round(Number(v || 0) * 100) / 100;
    return {
      employees: Number(r.employees) || 0,
      finalized: Number(r.finalized) || 0,
      gross: money(r.gross),
      deductions: money(r.deductions),
      net_pay: money(r.net_pay),
    };
  }

  /* ------------------------------------------------------- statutory rows */

  /**
   * Everything the ECR and the ESIC file need for one month, in TWO queries
   * whatever the headcount: the month's payrun snapshot rows (with the
   * current UAN / IP number beside them) and their stored calculations.
   */
  async listStatutoryRows({ year, month, store_ids }) {
    const location = locationPredicate("pe.store_id", store_ids);
    const employees = await this.query(
      `SELECT pe.payrun_employee_id, pe.employee_id, pe.employee_name, pe.store_id, pe.store_name,
              DATE_FORMAT(pe.resignation_date, '%Y-%m-%d') AS resignation_date,
              pe.pf_applicable, pe.esi_applicable, pe.uan, pe.pf_number, pe.esi_number,
              ne.uan AS live_uan, ne.esi_number AS live_ip
         FROM payrun_employee pe
         LEFT JOIN new_employee ne ON ne.employee_id = pe.employee_id
        WHERE pe.period_year = ? AND pe.period_month = ?
          ${location.clause ? `AND ${location.clause}` : ""}
        ORDER BY pe.employee_id ASC`,
      [year, month, ...location.params],
      "STATUTORY-EMPLOYEES"
    );
    if (employees.length === 0) return [];
    const calculations = await this.query(
      `SELECT * FROM payrun_employee_calculation
        WHERE period_year = ? AND period_month = ? AND employee_id IN (?)`,
      [year, month, employees.map((e) => Number(e.employee_id))],
      "STATUTORY-CALCULATIONS"
    );
    const byId = new Map(calculations.map((c) => [Number(c.employee_id), c]));
    return employees.map((e) => {
      const { live_uan, live_ip, ...employee } = e;
      return { employee, calculation: byId.get(Number(e.employee_id)) || null, live_uan, live_ip };
    });
  }

  /* --------------------------------------------------------------- layouts */

  _presentLayout(row) {
    if (!row) return null;
    return {
      report_type: row.report_type,
      year: Number(row.period_year),
      month: Number(row.period_month),
      field_keys: parseJson(row.field_keys, []),
      display: parseJson(row.display_prefs, {}),
      filters: parseJson(row.filters, {}),
      template_id: row.template_id === null || row.template_id === undefined ? null : Number(row.template_id),
      updated_at: row.updated_at,
    };
  }

  async getLayout({ user_id, report_type, year, month }) {
    const rows = await this.query(
      `SELECT * FROM payroll_report_layout
        WHERE user_id = ? AND report_type = ? AND period_year = ? AND period_month = ?
        LIMIT 1`,
      [Number(user_id), report_type, year, month],
      "GET-LAYOUT"
    );
    return this._presentLayout(rows[0]);
  }

  /** The most recent layout this user saved for this report type BEFORE the month. */
  async findLatestLayoutBefore({ user_id, report_type, year, month }) {
    const rows = await this.query(
      `SELECT * FROM payroll_report_layout
        WHERE user_id = ? AND report_type = ?
          AND (period_year < ? OR (period_year = ? AND period_month < ?))
        ORDER BY period_year DESC, period_month DESC
        LIMIT 1`,
      [Number(user_id), report_type, year, year, month],
      "LATEST-LAYOUT-BEFORE"
    );
    return this._presentLayout(rows[0]);
  }

  saveLayout({ user_id, report_type, year, month, field_keys, display, filters, template_id }) {
    return this.query(
      `INSERT INTO payroll_report_layout
         (user_id, report_type, period_year, period_month, field_keys, display_prefs, filters, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         field_keys = VALUES(field_keys),
         display_prefs = VALUES(display_prefs),
         filters = VALUES(filters),
         template_id = VALUES(template_id)`,
      [
        Number(user_id),
        report_type,
        year,
        month,
        JSON.stringify(field_keys || []),
        JSON.stringify(display || {}),
        JSON.stringify(filters || {}),
        template_id === null || template_id === undefined ? null : Number(template_id),
      ],
      "SAVE-LAYOUT"
    );
  }

  deleteLayout({ user_id, report_type, year, month }) {
    return this.query(
      `DELETE FROM payroll_report_layout
        WHERE user_id = ? AND report_type = ? AND period_year = ? AND period_month = ?`,
      [Number(user_id), report_type, year, month],
      "DELETE-LAYOUT"
    );
  }

  /* ------------------------------------------------------ default template */

  async getDefaultTemplateId({ user_id, report_type }) {
    const rows = await this.query(
      `SELECT template_id FROM payroll_report_default_template
        WHERE user_id = ? AND report_type = ? LIMIT 1`,
      [Number(user_id), report_type],
      "GET-DEFAULT"
    );
    return rows.length ? Number(rows[0].template_id) : null;
  }

  async listDefaultTemplateIds(user_id) {
    const rows = await this.query(
      "SELECT report_type, template_id FROM payroll_report_default_template WHERE user_id = ?",
      [Number(user_id)],
      "LIST-DEFAULTS"
    );
    const out = {};
    for (const r of rows) out[r.report_type] = Number(r.template_id);
    return out;
  }

  setDefaultTemplate({ user_id, report_type, template_id }) {
    return this.query(
      `INSERT INTO payroll_report_default_template (user_id, report_type, template_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE template_id = VALUES(template_id)`,
      [Number(user_id), report_type, Number(template_id)],
      "SET-DEFAULT"
    );
  }

  clearDefaultTemplate({ user_id, report_type }) {
    return this.query(
      "DELETE FROM payroll_report_default_template WHERE user_id = ? AND report_type = ?",
      [Number(user_id), report_type],
      "CLEAR-DEFAULT"
    );
  }

  /** A deleted template is nobody's default any more. */
  clearDefaultsForTemplate(template_id) {
    return this.query(
      "DELETE FROM payroll_report_default_template WHERE template_id = ?",
      [Number(template_id)],
      "CLEAR-DEFAULTS-FOR-TEMPLATE"
    );
  }
}

module.exports = (db) => new PayrollReportRepository(db);
module.exports.PayrollReportRepository = PayrollReportRepository;
