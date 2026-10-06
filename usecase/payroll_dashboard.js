const D = require("../utils/payroll_dashboard");
const { istToday } = require("../utils/istDate");
const { monthWindow } = require("../utils/payrun_eligibility");

/**
 * Payroll Dashboard - a read of the payroll month, assembled from the two
 * usecases the Payrun screens run on.
 *
 * IT CALCULATES NOTHING. The population and its Ready / Blocked / Initialized
 * verdicts are `PayrunUsecase.getMonth`'s; every calculation status, blocker
 * and figure is `PayrunCalculationUsecase.getMonthFigures`' - the same
 * `_assemble` / `_present` Calculation & Review lists. The dashboard counts
 * what they said, so the two screens cannot disagree.
 *
 * THE SCOPE IS THE SERVER'S. `store_ids` arrives resolved by the employee
 * branch scope (`null` company-wide, a list of branches, `[]` nobody) and is
 * handed to both usecases unchanged. The location / department / designation
 * FILTERS then narrow inside that scope only.
 */
class PayrollDashboardUsecase {
  constructor(repo, payrunUsecase, calculationUsecase, { today = null } = {}) {
    this.repo = repo;
    this.payrun = payrunUsecase;
    this.calculation = calculationUsecase;
    this.today = today || (() => istToday());
  }

  _todayMonth() {
    const [y, m] = String(this.today()).split("-").map(Number);
    return { year: y, month: m };
  }

  /** One row per employee of the month in scope - see `utils/payroll_dashboard.js#mergeMonth`. */
  async _month({ year, month, store_ids }) {
    const [init, calc] = await Promise.all([
      this.payrun.getMonth({ year, month, store_ids }),
      this.calculation.getMonthFigures({ year, month, store_ids }),
    ]);
    const ids = [
      ...new Set([...(init.rows || []), ...(calc.rows || [])].map((r) => Number(r.employee_id))),
    ];
    const { from, to } = monthWindow(year, month);
    const [facts, rejoins] = await Promise.all([
      this.repo.listEmployeeFacts(ids),
      this.repo.listRejoins(ids, from, to),
    ]);
    return {
      month_locked: Boolean(init.month_locked || calc.month_locked),
      rows: D.mergeMonth({ year, month, initRows: init.rows || [], calcRows: calc.rows || [], facts, rejoins }),
    };
  }

  /** The 12 payroll months of a financial year, with stored progress. */
  async getMonths({ fy, store_ids = null, filters = {} }) {
    const months = D.financialYearMonths(fy);
    const f = D.normalizeFilters(filters);
    const totals = await this.repo.listMonthTotals({
      from: months[0],
      to: months[11],
      store_ids: f.store_id === null ? store_ids : [f.store_id],
      department_id: f.department_id,
      designation_id: f.designation_id,
    });
    return {
      fy: Number(fy),
      label: `FY ${fy}-${String(Number(fy) + 1).slice(-2)}`,
      months: D.buildMonthStrip({ fy, totals, today: this._todayMonth() }),
    };
  }

  /** Every panel of the dashboard for one month and one set of filters. */
  async getSummary({ year, month, store_ids = null, filters = {}, compare = null }) {
    const target = compare && compare.year && compare.month ? compare : D.previousMonth(year, month);
    const [selected, other] = await Promise.all([
      this._month({ year, month, store_ids }),
      this._month({ year: target.year, month: target.month, store_ids }),
    ]);
    const rows = D.applyFilters(selected.rows, filters);
    const compareRows = D.applyFilters(other.rows, filters);
    return {
      period: { year, month, label: D.longLabel(year, month), month_locked: selected.month_locked },
      filters: {
        applied: D.normalizeFilters(filters),
        options: D.filterOptions(selected.rows, filters),
      },
      kpis: D.kpis(rows),
      headcount: D.headcount(rows),
      earnings: D.earnings(rows),
      comparison: D.comparison(rows, compareRows, { year, month }, { year: target.year, month: target.month }),
      movement: D.peopleMovement(rows),
      actions: D.actionItems(rows),
    };
  }

  /** The employees behind one number, a page at a time. */
  async getEmployees({ year, month, store_ids = null, filters = {}, metric, group_by = null, group_id = null, page = 1, page_size = 50 }) {
    const { rows } = await this._month({ year, month, store_ids });
    const selected = D.selectRows(D.applyFilters(rows, filters), { metric, group_by, group_id });
    if (selected === null) {
      const err = new Error("Unknown drill-down metric");
      err.name = "ValidationError";
      err.httpCode = 400;
      err.code = "INVALID_METRIC";
      throw err;
    }
    return { metric: String(metric).toUpperCase(), ...D.drilldown(selected, { page, page_size }) };
  }
}

module.exports = (...args) => new PayrollDashboardUsecase(...args);
module.exports.PayrollDashboardUsecase = PayrollDashboardUsecase;
