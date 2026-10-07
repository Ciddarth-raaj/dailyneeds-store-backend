/**
 * PAYROLL ELIGIBLE (Salary Not Applicable) - who is in the payroll population.
 *
 *   node --test usecase/payroll_eligible.test.js
 *
 * `new_employee.payroll_eligible = 0` takes an employee out of payroll for
 * every month not yet initialized, and nothing else: attendance, the Employee
 * Master and attendance reports carry on. The real SQL is proven in
 * `repository/payroll_eligible.mysql.test.js`; here the usecase is driven with
 * a fake whose population deliberately INCLUDES the ineligible employee, as if
 * the query had not filtered them, so the usecase's own guard is what is
 * being proven.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildUsecase = require("./payrun");
const { ROW_RESULT } = require("./payrun");
const { STATUS_GROUP, ATTENDANCE_STATUS } = require("../constants/payrun");
const { isPayrollEligible } = require("../utils/payrun_eligibility");

const YEAR = 2026;
const MONTH = 10;
const ACTOR = { employeeId: 7 };

const PAID = 42; // a normal, salary-applicable employee
const NOT_PAID = 1; // Salary Not Applicable (the Vinodh Kumar case)

const employee = (over = {}) => ({
  employee_id: PAID,
  employee_name: "Paid Person",
  status: 1,
  store_id: 3,
  store_name: "Anna Nagar",
  designation_id: 5,
  designation_name: "Billing Staff",
  department_id: 2,
  payment_type: 1,
  pf_applicable: 1,
  esi_applicable: 0,
  uan: "100200300400",
  pf_number: null,
  esi_number: null,
  account_no: "9988776655",
  ifsc: "HDFC0000123",
  date_of_joining: "2019-06-01",
  resignation_date: null,
  payroll_eligible: 1,
  ...over,
});

const salary = (id) => ({
  employee_id: id,
  salary_id: 900 + id,
  monthly_gross: 26000,
  daily_salary: 1000,
  basic: 13000,
  conveyance: 1600,
  hra: 5200,
  special_allowance: 6200,
  effective_from: "2026-04-01",
});

/** Attendance that is NOT settled - it would read "Attendance Needs Action". */
const openAttendance = (id) => ({
  employee_id: id,
  attendance_monthly_payroll_id: 5000 + id,
  is_final: 0,
  payroll_version: 1,
  calculated_at: "2026-10-05 04:00:00.000",
});

function fakeRepo({ population, salaries, attendance = [], pending = [], existing = [] }) {
  const store = existing.slice();
  const inserts = [];
  return {
    inserts,
    store,
    async getPeriod() {
      return null;
    },
    async listPopulation() {
      return population;
    },
    async listApprovedSalaries(ids) {
      return salaries.filter((s) => ids.includes(s.employee_id));
    },
    async listAttendanceMonths(ids) {
      return attendance.filter((a) => ids.includes(a.employee_id));
    },
    async listPendingApprovals(ids) {
      return pending.filter((p) => ids.includes(p.employee_id));
    },
    async listPayrunRows({ year, month }) {
      return store.filter((r) => r.period_year === year && r.period_month === month);
    },
    async listExitRecords(ids) {
      return population
        .filter((e) => ids.includes(e.employee_id))
        .map((e) => ({ employee_id: e.employee_id, resignation_date: null, status: 1, current_period_state: "open", current_resignations: 0 }));
    },
    async listLastPresentDates() {
      return [];
    },
    async listAttendanceDays() {
      return [];
    },
    async insertSnapshots(rows) {
      rows.forEach((row) => {
        inserts.push(row);
        store.push({ ...row, payrun_employee_id: store.length + 1 });
      });
      return store.map((r) => ({ employee_id: r.employee_id, payrun_employee_id: r.payrun_employee_id, pay_type: r.pay_type, pay_type_source: r.pay_type_source }));
    },
  };
}

/**
 * The month as it was for Vinodh Kumar: a salary-applicable employee beside
 * one who is Salary Not Applicable, has no approved salary and has unsettled
 * attendance with an open regularization.
 */
const scenario = (over = {}) =>
  fakeRepo({
    population: [
      employee(),
      employee({ employee_id: NOT_PAID, employee_name: "Vinodh Kumar", payroll_eligible: 0, account_no: null, ifsc: null }),
    ],
    salaries: [salary(PAID)],
    attendance: [{ ...openAttendance(PAID), is_final: 1 }, openAttendance(NOT_PAID)],
    pending: [{ employee_id: NOT_PAID, pending_regularizations: 2, pending_ot: 1 }],
    ...over,
  });

const ids = (view) => view.rows.map((r) => r.employee_id);

describe("the rule itself", () => {
  it("only an explicit No excludes; a row without the column is eligible", () => {
    assert.equal(isPayrollEligible({ payroll_eligible: 1 }), true);
    assert.equal(isPayrollEligible({ payroll_eligible: "1" }), true);
    assert.equal(isPayrollEligible({ payroll_eligible: 0 }), false);
    assert.equal(isPayrollEligible({ payroll_eligible: "0" }), false);
    assert.equal(isPayrollEligible({ payroll_eligible: false }), false);
    assert.equal(isPayrollEligible({}), true, "an older row reads as eligible - the column default");
    assert.equal(isPayrollEligible({ payroll_eligible: null }), true);
  });
});

describe("1-2. who is in the payroll population", () => {
  it("1. a salary-applicable employee appears normally, READY", async () => {
    const view = await buildUsecase(scenario()).getMonth({ year: YEAR, month: MONTH });
    const row = view.rows.find((r) => r.employee_id === PAID);
    assert.ok(row, "the paid employee is listed");
    assert.equal(row.status, STATUS_GROUP.READY);
  });

  it("2. a Salary Not Applicable employee does not appear at all - not even as BLOCKED", async () => {
    const view = await buildUsecase(scenario()).getMonth({ year: YEAR, month: MONTH });
    assert.deepEqual(ids(view), [PAID]);
    assert.ok(!view.rows.some((r) => r.status === STATUS_GROUP.BLOCKED), "no 'Blocked - Salary not approved' row");
  });

  it("2b. every filter and search reads the same, smaller population", async () => {
    const uc = buildUsecase(scenario());
    for (const filter of [{ status: STATUS_GROUP.BLOCKED }, { search: "Vinodh" }, { search: String(NOT_PAID) }]) {
      const view = await uc.getMonth({ year: YEAR, month: MONTH, ...filter });
      assert.ok(!ids(view).includes(NOT_PAID), JSON.stringify(filter));
    }
  });
});

describe("3 + 5. no count is inflated by them", () => {
  it("All Employees, Ready, Blocked, Initialized, Attendance Needs Action and Closed for Payroll count only payroll employees", async () => {
    const { summary } = await buildUsecase(scenario()).getMonth({ year: YEAR, month: MONTH });
    assert.equal(summary.total_eligible, 1, "All Employees");
    assert.equal(summary.ready, 1);
    assert.equal(summary.blocked, 0, "Blocked does not include Salary Not Applicable");
    assert.equal(summary.initialized, 0);
    assert.equal(summary.attendance_closed_for_payroll, 0);
    assert.equal(summary.attendance_pending, 0, "their open attendance does not raise Attendance Needs Action");
  });

  it("5. the same month WITHOUT the flag would have counted them - the flag is what removes them", async () => {
    const repo = scenario({
      population: [employee(), employee({ employee_id: NOT_PAID, payroll_eligible: 1, account_no: null, ifsc: null })],
    });
    const { summary, rows } = await buildUsecase(repo).getMonth({ year: YEAR, month: MONTH });
    assert.equal(summary.total_eligible, 2);
    assert.equal(summary.blocked, 1);
    const them = rows.find((r) => r.employee_id === NOT_PAID);
    assert.equal(them.status, STATUS_GROUP.BLOCKED);
    assert.equal(them.attendance_status, ATTENDANCE_STATUS.PENDING, "control: their attendance WOULD count as needing action");
  });
});

describe("3b. the Payroll Dashboard reads the same population", () => {
  it("Total Employees, Initialized and Not Initialized leave out Salary Not Applicable", async () => {
    const buildDashboard = require("./payroll_dashboard");
    const payrun = buildUsecase(scenario());
    const calculation = { async getMonthFigures() { return { rows: [], month_locked: false }; } };
    const dashboardRepo = {
      async listEmployeeFacts(ids) { return ids.map((employee_id) => ({ employee_id, department_id: 2, department_name: "Billing", employment_type: null })); },
      async listPeriodsInWindow() { return []; },
    };
    const summary = await buildDashboard(dashboardRepo, payrun, calculation).getSummary({ year: YEAR, month: MONTH });
    assert.equal(summary.kpis.total_employees, 1);
    assert.equal(summary.kpis.not_initialized, 1, "only the paid employee is waiting to be initialized");
    assert.equal(summary.kpis.initialized, 0);
  });
});

describe("6-7. initialization", () => {
  it("6. a direct Initialize request for them is refused and writes nothing", async () => {
    const repo = scenario();
    const out = await buildUsecase(repo).initialize({ year: YEAR, month: MONTH, employee_ids: [NOT_PAID], actor: ACTOR });
    assert.equal(out.initialized_count, 0);
    assert.equal(out.results[0].result, ROW_RESULT.NOT_IN_SCOPE);
    assert.match(out.results[0].message, /not in the selected month's payroll population/);
    assert.equal(repo.inserts.length, 0, "no payrun row was written");
  });

  it("7. bulk Initialize (Select All Ready) initializes the paid employee and leaves them out", async () => {
    const repo = scenario();
    const uc = buildUsecase(repo);
    const view = await uc.getMonth({ year: YEAR, month: MONTH });
    const allReady = view.rows.filter((r) => r.status === STATUS_GROUP.READY).map((r) => r.employee_id);
    assert.deepEqual(allReady, [PAID], "Select All Ready never offers them");

    // Even a hand-built bulk request that names them initializes only the paid employee.
    const out = await uc.initialize({ year: YEAR, month: MONTH, employee_ids: [PAID, NOT_PAID], actor: ACTOR });
    assert.equal(out.initialized_count, 1);
    assert.deepEqual(repo.inserts.map((r) => r.employee_id), [PAID]);
    assert.equal(out.results.find((r) => r.employee_id === NOT_PAID).result, ROW_RESULT.NOT_IN_SCOPE);
  });
});

describe("10. a month already initialized is history and stays", () => {
  it("someone initialized BEFORE being marked Salary Not Applicable is still in that month, as INITIALIZED", async () => {
    const repo = scenario({
      salaries: [salary(PAID), salary(NOT_PAID)],
      existing: [{ period_year: YEAR, period_month: MONTH, employee_id: NOT_PAID, payrun_employee_id: 1, pay_type: "CASH", pay_type_source: "EMPLOYEE_MASTER" }],
    });
    const view = await buildUsecase(repo).getMonth({ year: YEAR, month: MONTH });
    const them = view.rows.find((r) => r.employee_id === NOT_PAID);
    assert.ok(them, "the existing payrun is not hidden from its own month");
    assert.equal(them.status, STATUS_GROUP.INITIALIZED);
    assert.equal(view.summary.initialized, 1);
  });

  it("a different month's payrun row does not bring them back into this month", async () => {
    const repo = scenario({
      existing: [{ period_year: YEAR, period_month: MONTH - 1, employee_id: NOT_PAID, payrun_employee_id: 1, pay_type: "CASH", pay_type_source: "EMPLOYEE_MASTER" }],
    });
    const view = await buildUsecase(repo).getMonth({ year: YEAR, month: MONTH });
    assert.ok(!ids(view).includes(NOT_PAID));
  });
});

/* ------------------------------------------------- the boundary, in source */

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("4. attendance is untouched", () => {
  it("no attendance usecase, rule or repository reads payroll_eligible", () => {
    const dirs = ["usecase", "utils", "repository"];
    const offenders = [];
    dirs.forEach((dir) => {
      fs.readdirSync(path.join(ROOT, dir))
        .filter((f) => /^attendance.*\.js$/.test(f) && !f.endsWith(".test.js"))
        .forEach((f) => {
          if (code(read(`${dir}/${f}`)).includes("payroll_eligible")) offenders.push(`${dir}/${f}`);
        });
    });
    assert.deepEqual(offenders, [], "attendance must keep working for Salary Not Applicable employees");
  });

  it("setting the flag changes only the flag - not status, resignation or attendance_required", () => {
    const repo = code(read("repository/employee_master.js"));
    const update = repo.slice(repo.indexOf("async setPayrollEligible"), repo.indexOf("async setPayrollEligible") + 400);
    assert.match(update, /UPDATE new_employee SET payroll_eligible = \? WHERE employee_id = \?/);
    assert.ok(!/status|resignation_date|attendance_required/.test(update));
  });
});

describe("8-9. nothing downstream of initialization can include them", () => {
  it("the ONLY write of a payrun_employee row is insertSnapshots, and it re-checks payroll_eligible under lock", () => {
    const writers = [];
    ["repository", "usecase", "utils", "services"].forEach((dir) => {
      fs.readdirSync(path.join(ROOT, dir))
        .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
        .forEach((f) => {
          if (/INSERT[A-Z ]*INTO\s+`?payrun_employee`?\s*\(/.test(code(read(`${dir}/${f}`)))) writers.push(`${dir}/${f}`);
        });
    });
    assert.deepEqual(writers, ["repository/payrun.js"]);
    const repo = code(read("repository/payrun.js"));
    const insert = repo.slice(repo.indexOf("async insertSnapshots"), repo.indexOf("INSERT-SNAPSHOTS"));
    assert.match(insert, /payroll_eligible = 0\s+FOR UPDATE/, "the guard runs inside the insert transaction");
    assert.match(insert, /Nothing was initialized/);
  });

  it("calculation, payslips, bank/cash output, the dashboard and the report engine all start from payrun rows", () => {
    assert.match(code(read("usecase/payrun_calculation.js")), /const population = await this\.repo\.listInitialized\(/);
    assert.match(code(read("repository/payrun_calculation.js")), /FROM payrun_employee pe/);
    assert.match(code(read("utils/payroll_report_query.js")), /"FROM payrun_employee pe"/);
    const reports = code(read("repository/payroll_report.js"));
    assert.match(reports, /FROM payrun_employee_calculation c\s+JOIN payrun_employee pe/, "the cash payment rows");
    assert.match(code(read("repository/payroll_dashboard.js")), /FROM payrun_employee pe/);
  });

  it("the population query itself carries the rule, keeping only this month's existing payrun", () => {
    const repo = code(read("repository/payrun.js"));
    const population = repo.slice(repo.indexOf("async listPopulation"), repo.indexOf("LIST-POPULATION"));
    assert.match(population, /ne\.payroll_eligible = 1/);
    assert.match(population, /pe_existing\.period_year = \? AND pe_existing\.period_month = \?/);
  });
});

describe("verification gates", () => {
  it("A. the same employee with Yes behaves exactly like today - BLOCKED with no approved salary, and initializes once one is approved", async () => {
    const yes = (salaries) =>
      scenario({ population: [employee(), employee({ employee_id: NOT_PAID, employee_name: "Vinodh Kumar", payroll_eligible: 1 })], salaries });
    const blocked = await buildUsecase(yes([salary(PAID)])).getMonth({ year: YEAR, month: MONTH });
    assert.equal(blocked.rows.find((r) => r.employee_id === NOT_PAID).status, STATUS_GROUP.BLOCKED);
    const ready = await buildUsecase(yes([salary(PAID), salary(NOT_PAID)])).getMonth({ year: YEAR, month: MONTH });
    assert.ok(ready.rows.some((r) => r.employee_id === NOT_PAID), "listed once salary is approved");
  });

  it("C. a normal Yes employee's row is identical whether a colleague is Yes or No", async () => {
    const withNo = await buildUsecase(scenario()).getMonth({ year: YEAR, month: MONTH });
    const withYes = await buildUsecase(
      scenario({ population: [employee(), employee({ employee_id: NOT_PAID, payroll_eligible: 1, account_no: null, ifsc: null })] })
    ).getMonth({ year: YEAR, month: MONTH });
    assert.deepEqual(
      withNo.rows.find((r) => r.employee_id === PAID),
      withYes.rows.find((r) => r.employee_id === PAID)
    );
  });

  it("D. nobody becomes No automatically: the migration updates no row and no code names an employee id", () => {
    const root = path.join(__dirname, "..");
    const up = fs.readFileSync(path.join(root, "migrations/mysql/migrations/sqls/20261124120000-employee-payroll-eligible-up.sql"), "utf8");
    assert.ok(!/^\s*UPDATE\b/im.test(up) && !/'UPDATE /i.test(up), "the migration sets no value - every row takes DEFAULT 1");
    assert.ok(!/employee_id\s*(=|IN)\s*\(?\s*\d/i.test(up), "the migration names no employee");
    for (const rel of ["repository/payrun.js", "usecase/payrun.js", "utils/payrun_eligibility.js", "usecase/employee_master.js", "repository/employee_master.js"]) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(!/employee_?[iI]d\s*={2,3}\s*\d/.test(src), `${rel} has no employee-id special case`);
    }
    const utils = fs.readFileSync(path.join(root, "utils/payrun_eligibility.js"), "utf8");
    const start = utils.indexOf("function isPayrollEligible(");
    const rule = utils.slice(start, utils.indexOf("\n}\n", start));
    assert.match(rule, /payroll_eligible/);
    for (const inferred of ["designation", "payment_type", "pf_applicable", "esi_applicable", "attendance_required", "salary"]) {
      assert.ok(!new RegExp(`employee\\.${inferred}`).test(rule), `the rule does not infer from ${inferred}`);
    }
  });
});
