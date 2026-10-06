/**
 * Payroll Dashboard against REAL MySQL, on the FULL production schema.
 *
 *   PAYROLL_DASHBOARD_TEST_MYSQL=mysql://user:pass@127.0.0.1/scratch_db \
 *     node --test repository/payroll_dashboard.mysql.test.js
 *
 * SKIPPED unless `PAYROLL_DASHBOARD_TEST_MYSQL` names a SCRATCH database on
 * which `db-migrate up` has been run (every migration in migrations/mysql).
 * Unlike the stand-in suites, nothing here creates a table: the dashboard's
 * SQL meets the real columns, types, keys and collations.
 *
 * Nothing writes a payroll figure by hand. The production usecases INITIALIZE,
 * CALCULATE and APPROVE the months; the dashboard is then read through its own
 * repository and usecase and reconciled to the stored payrun rows with
 * independent SQL. All seeded rows use ids >= 990001 / 9901 and are removed
 * before and after.
 *
 * MONTHS
 *   Aug 2026  completed: everybody initialized, calculated, approved
 *             - a joiner (1 Aug), a leaver (31 Aug), a rejoin (10 Aug)
 *   Sep 2026  partial: some calculated, some only initialized, one blocked
 *             (no approved salary) and never initialized
 *   Oct 2026  not started
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.PAYROLL_DASHBOARD_TEST_MYSQL;
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");

const ACTOR = { employeeId: 77, userId: 7 };
const E = (n) => 990000 + n;
const STORES = [[9901, "SCR Moolakulam"], [9902, "SCR ECR"], [9903, "SCR Lawspet"]];
const DEPTS = [[9901, "SCR Billing"], [9902, "SCR Stores"]];
const DESIGS = [[9901, "SCR Cashier"], [9902, "SCR Loader"], [9903, "SCR Supervisor"]];

/*
 * [n, store, dept, desig, gross, pf, esi, joined, resigned, type]
 *   n 1..9   ordinary staff across the three branches
 *   n 10     joined 1 Aug 2026
 *   n 11     resigned 31 Aug 2026
 *   n 12     rejoined 10 Aug 2026 (period 1 ended 31 May 2026)
 *   n 13     no approved salary - blocked in September, never initialized
 */
const STAFF = [
  [1, 9901, 9901, 9901, 15000, 1, 1, "2019-04-01", null, "Permanent"],
  [2, 9901, 9901, 9901, 18000, 1, 1, "2020-01-15", null, "Permanent"],
  [3, 9901, 9902, 9902, 12500, 1, 1, "2021-06-01", null, "Contract"],
  [4, 9902, 9901, 9901, 16000, 1, 1, "2019-04-01", null, "Permanent"],
  [5, 9902, 9902, 9902, 13000, 0, 0, "2022-02-01", null, "Contract"],
  [6, 9902, 9902, 9903, 32000, 1, 0, "2018-04-01", null, "Permanent"],
  [7, 9903, 9901, 9901, 14500, 1, 1, "2023-03-01", null, "Permanent"],
  [8, 9903, 9902, 9902, 12000, 0, 1, "2023-03-01", null, "Contract"],
  [9, 9903, 9902, 9903, 28000, 1, 0, "2017-11-01", null, "Permanent"],
  [10, 9901, 9901, 9901, 15500, 1, 1, "2026-08-01", null, "Permanent"],
  [11, 9902, 9901, 9901, 14000, 1, 1, "2020-05-01", "2026-08-31", "Permanent"],
  [12, 9903, 9902, 9902, 13500, 1, 1, "2026-08-10", null, "Permanent"],
  [13, 9901, 9902, 9902, 0, 0, 0, "2026-09-02", null, "Contract"],
];
const IDS = STAFF.map((s) => E(s[0]));

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

function days(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
}

async function cleanup(pool) {
  const ids = IDS;
  for (const t of [
    "payrun_payslip_notification",
    "payrun_payslip",
    "payrun_employee_lifecycle_audit",
    "payrun_employee_calculation_reset_audit",
    "payrun_employee_calculation_audit",
    "payrun_employee_calculation",
    "payrun_attendance_close_audit",
    "payrun_employee_adjustment_audit",
    "payrun_employee_adjustment_state",
    "payrun_employee_adjustment",
    "payrun_employee_pay_type_audit",
    "payrun_employee",
  ]) {
    await q(pool, `DELETE FROM \`${t}\` WHERE employee_id IN (?)`, [ids]);
  }
  await q(pool, "DELETE FROM attendance_monthly_payroll WHERE employee_id IN (?)", [ids]);
  await q(pool, "DELETE FROM attendance_day_calculation WHERE employee_id IN (?)", [ids]);
  await q(pool, "DELETE FROM employee_salary WHERE employee_id IN (?)", [ids]);
  await q(pool, "DELETE FROM employee_lifecycle_event WHERE employee_id IN (?)", [ids]);
  await q(pool, "DELETE FROM employee_employment_period WHERE employee_id IN (?)", [ids]);
  await q(pool, "DELETE FROM new_employee WHERE employee_id IN (?)", [ids]);
  await q(pool, "DELETE FROM outlets WHERE outlet_id IN (?)", [STORES.map((s) => s[0])]);
  await q(pool, "DELETE FROM department WHERE department_id IN (?)", [DEPTS.map((s) => s[0])]);
  await q(pool, "DELETE FROM designation WHERE designation_id IN (?)", [DESIGS.map((s) => s[0])]);
}

/** The attendance engine's stored month, as it would leave it: settled, every working day present. */
async function seedAttendance(pool, n, gross, year, month, joined) {
  const all = days(year, month);
  const from = joined && joined > all[0] ? joined : all[0];
  for (const d of all) {
    const employed = d >= from;
    await q(pool, `INSERT INTO attendance_day_calculation
        (employee_id, attendance_date, status, is_final, attendance_day_count, nrm_minutes, base_nrm_minutes,
         worked_minutes, shortage_minutes, approved_ot_minutes, ot_rate, permission_minutes, calculation_version,
         attendance_calculation_mode, raw_punch_ids, effective_punches, shift_snapshot, shift_snapshot_hash)
       VALUES (?, ?, ?, 1, ?, 480, 480, ?, 0, 0, 1, 0, 11, 'SHIFT_BASED', '[]', '[]', '{}', REPEAT('0', 32))`,
    [E(n), d, employed ? "FINAL" : "ABSENT", employed ? 1 : 0, employed ? 480 : 0]);
  }
  const stored = await q(pool, dayRowsSql(), [E(n), all[0], all[all.length - 1]]);
  const base = all.length - Math.floor(all.length / 7);
  const present = all.filter((d) => d >= from).length;
  const salaryDays = Math.min(present, base);
  const daily = Math.round((gross / 26) * 100) / 100;
  await q(pool, `INSERT INTO attendance_monthly_payroll
      (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
       monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
       approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
     VALUES (?, ?, ?, 1, 1, ?, 0, ?, ?, ?, ?, 0, 0, 0, 0, 0, '2026-10-01 02:00:00.000', ?)`,
  [E(n), year, month, salaryDays, base, gross, daily, Math.round(daily * salaryDays * 100) / 100, dayRowsFingerprint(stored)]);
}

describe("payroll dashboard on real MySQL (full migrated schema)", { skip: !URL && "PAYROLL_DASHBOARD_TEST_MYSQL is not set" }, () => {
  let pool;
  let dashboard;
  let calculation;
  let dashRepo;
  const queries = { count: 0 };

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=8&multipleStatements=true`);
    // Count every statement the dashboard sends (performance review).
    const raw = pool.query.bind(pool);
    pool.query = (...args) => {
      queries.count += 1;
      return raw(...args);
    };
    await cleanup(pool);

    for (const [id, name] of STORES) await q(pool, "INSERT INTO outlets (outlet_id, outlet_code, outlet_name) VALUES (?, ?, ?)", [id, `SCR${id}`, name]);
    for (const [id, name] of DEPTS) await q(pool, "INSERT INTO department (department_id, department_name) VALUES (?, ?)", [id, name]);
    for (const [id, name] of DESIGS) await q(pool, "INSERT INTO designation (designation_id, designation_name, login_access, online_portal) VALUES (?, ?, 0, 0)", [id, name]);

    for (const [n, store, dept, desig, gross, pf, esi, joined, resigned, type] of STAFF) {
      await q(pool, `INSERT INTO new_employee
          (employee_id, employee_name, store_id, department_id, designation_id, date_of_joining, resignation_date,
           status, employment_type, pf_applicable, esi_applicable, uan, esi_number, previous_eps_member, previous_pf_member,
           dob, payment_type, attendance_required)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '1990-06-15', 1, 1)`,
      [E(n), `SCR Staff ${n}`, store, dept, desig, joined, resigned, resigned ? 0 : 1, type, pf, esi,
        pf ? `1002003${String(n).padStart(5, "0")}` : null, esi ? `31000${String(n).padStart(5, "0")}` : null]);
      if (gross > 0) {
        await q(pool, `INSERT INTO employee_salary
            (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status,
             source, pf_status, esi_status, ctc_status, statutory_config_version, statutory_snapshot)
          VALUES (?, ?, ?, ?, 1600, ?, ?, '2017-01-01', 'APPROVED', 'OPENING_SALARY', 'APPLIED', 'APPLIED', 'APPLIED', 'v1', '{}')`,
        [E(n), gross, Math.round((gross / 26) * 100) / 100, gross / 2, gross * 0.2, gross - gross / 2 - 1600 - gross * 0.2]);
      }
      // Employment history: one period, or - for the rejoiner - a closed first spell and a second.
      if (n === 12) {
        await q(pool, "INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type, source) VALUES (?, 1, 'closed', '2019-01-01', '2026-05-31', 'resignation', 'local')", [E(n)]);
        await q(pool, "INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, source) VALUES (?, 2, 'open', '2026-08-10', 'local')", [E(n)]);
      } else {
        await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type, source)
          VALUES (?, 1, ?, ?, ?, ?, 'local')`, [E(n), resigned ? "closed" : "open", joined, resigned, resigned ? "resignation" : null]);
      }
    }
    for (const [n, , , , gross, , , joined] of STAFF) {
      if (gross > 0) {
        await seedAttendance(pool, n, gross, 2026, 8, joined > "2026-08-01" ? joined : null);
        if (n !== 11) await seedAttendance(pool, n, gross, 2026, 9, null);
      }
    }

    const payrunRepo = require("./payrun")(pool);
    const calcRepo = require("./payrun_calculation")(pool);
    const adjRepo = require("./payrun_adjustment")(pool);
    const locks = { listLockedEmployeeIds: (args) => calcRepo.listLockedEmployeeIds(args) };
    const payrun = require("../usecase/payrun")(payrunRepo, locks, { today: () => "2026-10-06" });
    calculation = require("../usecase/payrun_calculation")(calcRepo, payrunRepo, adjRepo);
    calculation.today = () => "2026-10-06";
    const adjustments = require("../usecase/payrun_adjustment")(adjRepo, payrunRepo, locks);
    dashRepo = require("./payroll_dashboard")(pool);
    dashboard = require("../usecase/payroll_dashboard")(dashRepo, payrun, calculation, { today: () => "2026-10-06" });

    const confirmNone = async (year, month, ids) => {
      for (const id of ids) {
        await q(pool, `INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by)
          SELECT payrun_employee_id, period_year, period_month, employee_id, 1, 9 FROM payrun_employee WHERE period_year = ? AND period_month = ? AND employee_id = ?`, [year, month, id]);
      }
    };
    void adjustments;

    // AUGUST: initialize, calculate and approve everybody employed in August.
    const augIds = STAFF.filter((s) => s[0] <= 12).map((s) => E(s[0]));
    const augInit = await payrun.initialize({ year: 2026, month: 8, employee_ids: augIds, actor: ACTOR });
    assert.equal(augInit.initialized_count, augIds.length, JSON.stringify(augInit));
    await confirmNone(2026, 8, augIds);
    const augCalc = await calculation.calculate({ year: 2026, month: 8, all_eligible: true, actor: ACTOR });
    assert.equal(augCalc.calculated_count, augIds.length, JSON.stringify(augCalc.results));
    const augOk = await calculation.approve({ year: 2026, month: 8, employee_ids: augIds, actor: ACTOR });
    assert.equal(augOk.approved_count, augIds.length, JSON.stringify(augOk.results));

    // SEPTEMBER: 1-9 initialized; 1-5 calculated; 13 has no salary (blocked); 10, 12 not initialized yet.
    const sepInit = STAFF.filter((s) => s[0] <= 9).map((s) => E(s[0]));
    const sep = await payrun.initialize({ year: 2026, month: 9, employee_ids: sepInit, actor: ACTOR });
    assert.equal(sep.initialized_count, sepInit.length, JSON.stringify(sep));
    await confirmNone(2026, 9, sepInit);
    const sepCalc = await calculation.calculate({ year: 2026, month: 9, employee_ids: sepInit.slice(0, 5), actor: ACTOR });
    assert.equal(sepCalc.calculated_count, 5, JSON.stringify(sepCalc.results));
  });

  after(async () => {
    if (!pool) return;
    await cleanup(pool);
    pool.end();
  });

  /** Independent SQL: the stored calculation, summed straight from the payrun tables, by snapshot dims. */
  const stored = async (year, month, where = "1 = 1", params = []) => {
    const [r] = await q(pool, `SELECT COUNT(*) AS n,
              COALESCE(SUM(c.total_earnings), 0) AS gross,
              COALESCE(SUM(c.total_employee_deductions), 0) AS ded,
              COALESCE(SUM(c.net_pay), 0) AS net,
              COALESCE(SUM(c.net_pay_rounding), 0) AS rounding,
              COALESCE(SUM(c.employee_pf), 0) AS pf,
              COALESCE(SUM(c.employee_esi), 0) AS esi
         FROM payrun_employee pe
         JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
        WHERE pe.period_year = ? AND pe.period_month = ? AND pe.employee_id IN (?) AND ${where}`, [year, month, IDS, ...params]);
    const f = (v) => Number(v).toFixed(2);
    return { n: Number(r.n), gross: f(r.gross), ded: f(r.ded), net: f(r.net), rounding: f(r.rounding), pf: f(r.pf), esi: f(r.esi) };
  };
  const SCOPE = STORES.map((s) => s[0]);

  it("a completed month: KPIs reconcile to the stored payrun, to the paisa", async () => {
    const s = await dashboard.getSummary({ year: 2026, month: 8, store_ids: SCOPE });
    const db = await stored(2026, 8);
    assert.equal(s.kpis.total_employees, 12);
    assert.equal(s.kpis.initialized, 12);
    assert.equal(s.kpis.not_initialized, 0);
    assert.equal(s.kpis.costed_employees, db.n);
    assert.deepEqual([s.kpis.payroll_cost, s.kpis.total_deductions, s.kpis.net_payable, s.kpis.net_pay_rounding], [db.gross, db.ded, db.net, db.rounding]);
    const p = (v) => Math.round(Number(v) * 100);
    assert.equal(p(s.kpis.payroll_cost) - p(s.kpis.total_deductions) + p(s.kpis.net_pay_rounding), p(s.kpis.net_payable));
    const b = Object.fromEntries(s.earnings.breakdown.map((x) => [x.key, x]));
    assert.deepEqual([b.PF.amount, b.ESI.amount], [db.pf, db.esi]);
    assert.equal(b.PT.amount, null);
    assert.equal(b.IT.amount, null);
    s.actions.filter((a) => a.key !== "PENDING_APPROVAL").forEach((a) => assert.equal(a.count, 0, `${a.key} in a completed month`));
  });

  it("and agrees, employee by employee, with Calculation & Review's own detail", async () => {
    const drill = await dashboard.getEmployees({ year: 2026, month: 8, store_ids: SCOPE, metric: "COSTED", page_size: 200 });
    for (const row of drill.rows) {
      const detail = await calculation.getEmployee({ year: 2026, month: 8, employee_id: row.employee_id, store_ids: SCOPE });
      const fin = detail.breakup.final;
      assert.deepEqual(
        [row.gross, row.deductions, row.net].map(Number),
        [fin.total_earnings, fin.total_employee_deductions, fin.net_pay].map(Number),
        `employee ${row.employee_id}`
      );
    }
  });

  it("people movement: joiner on the 1st, leaver on the 31st, rejoin on the 10th", async () => {
    const s = await dashboard.getSummary({ year: 2026, month: 8, store_ids: SCOPE });
    const m = Object.fromEntries(s.movement.map((x) => [x.key, x]));
    const ids = async (metric) => (await dashboard.getEmployees({ year: 2026, month: 8, store_ids: SCOPE, metric })).rows.map((r) => r.employee_id);
    assert.deepEqual(await ids("MOVE_JOINED"), [E(10)]);
    assert.deepEqual(await ids("MOVE_RESIGNED"), [E(11)]);
    assert.deepEqual(await ids("MOVE_REJOINED"), [E(12)]);
    const leaver = await stored(2026, 8, "pe.employee_id = ?", [E(11)]);
    assert.deepEqual([m.RESIGNED.count, m.RESIGNED.payroll_cost, m.RESIGNED.net_wages], [1, leaver.gross, leaver.net]);
  });

  it("Location, Department and Designation filters - alone and combined - match independent SQL on the snapshot", async () => {
    const cases = [
      [{ store_id: 9901 }, "pe.store_id = ?", [9901]],
      [{ department_id: 9902 }, "pe.department_id = ?", [9902]],
      [{ designation_id: 9903 }, "pe.designation_id = ?", [9903]],
      [{ store_id: 9902, department_id: 9902, designation_id: 9902 }, "pe.store_id = ? AND pe.department_id = ? AND pe.designation_id = ?", [9902, 9902, 9902]],
    ];
    for (const [filters, where, params] of cases) {
      const s = await dashboard.getSummary({ year: 2026, month: 8, store_ids: SCOPE, filters });
      const db = await stored(2026, 8, where, params);
      assert.deepEqual([s.kpis.total_employees, s.kpis.payroll_cost, s.kpis.net_payable], [db.n, db.gross, db.net], JSON.stringify(filters));
      const drill = await dashboard.getEmployees({ year: 2026, month: 8, store_ids: SCOPE, filters, metric: "ALL", page_size: 200 });
      assert.equal(drill.total, db.n, `drill-down keeps ${JSON.stringify(filters)}`);
    }
  });

  it("dependent filter options come from the month in scope", async () => {
    const s = await dashboard.getSummary({ year: 2026, month: 8, store_ids: [9903], filters: { store_id: 9903 } });
    assert.deepEqual(s.filters.options.locations.map((l) => l.id), [9903], "a branch user is offered only their branch");
    const atEcrStores = await dashboard.getSummary({ year: 2026, month: 8, store_ids: SCOPE, filters: { store_id: 9902, department_id: 9902 } });
    assert.deepEqual(atEcrStores.filters.options.designations.map((d) => d.id).sort(), [9902, 9903]);
  });

  it("a partial month: not initialized, not calculated and the blocked employee are exact", async () => {
    const s = await dashboard.getSummary({ year: 2026, month: 9, store_ids: SCOPE });
    // 1-9 initialized; 10 and 12 ready but not initialized; 13 blocked (no salary). 11 left in August.
    assert.equal(s.kpis.total_employees, 12);
    assert.equal(s.kpis.initialized, 9);
    assert.equal(s.kpis.not_initialized, 3);
    assert.equal(s.kpis.costed_employees, 5);
    assert.equal(s.kpis.uncosted_initialized, 4);
    const action = Object.fromEntries(s.actions.map((a) => [a.key, a]));
    assert.equal(action.NOT_INITIALIZED.count, 3);
    assert.equal(action.SALARY_NOT_APPROVED.count, 1);
    assert.equal(action.NOT_CALCULATED.count, 4);
    const blocked = await dashboard.getEmployees({ year: 2026, month: 9, store_ids: SCOPE, metric: "ACTION_SALARY_NOT_APPROVED" });
    assert.deepEqual(blocked.rows.map((r) => [r.employee_id, r.reasons]), [[E(13), ["Salary not approved"]]]);
    const uncosted = await dashboard.getEmployees({ year: 2026, month: 9, store_ids: SCOPE, metric: "UNCOSTED" });
    assert.deepEqual(uncosted.rows.map((r) => r.employee_id).sort(), [E(6), E(7), E(8), E(9)]);
    for (const a of s.actions) {
      const d = await dashboard.getEmployees({ year: 2026, month: 9, store_ids: SCOPE, metric: a.metric, page_size: 200 });
      assert.equal(d.total, a.count, `${a.key}: count = drill-down`);
    }
  });

  it("comparison: September against August, under the same filter", async () => {
    const s = await dashboard.getSummary({ year: 2026, month: 9, store_ids: SCOPE, filters: { store_id: 9901 }, compare: { year: 2026, month: 8 } });
    const m = Object.fromEntries(s.comparison.metrics.map((x) => [x.key, x]));
    const aug = await stored(2026, 8, "pe.store_id = ?", [9901]);
    const sep = await stored(2026, 9, "pe.store_id = ?", [9901]);
    assert.deepEqual([m.GROSS.base, m.GROSS.compare], [sep.gross, aug.gross]);
    assert.equal(m.PT.tracked, false);
  });

  it("the month strip: completed, partial and not-started months from stored state", async () => {
    const strip = await dashboard.getMonths({ fy: 2026, store_ids: SCOPE });
    const by = Object.fromEntries(strip.months.map((x) => [`${x.year}-${x.month}`, x]));
    assert.equal(by["2026-8"].status, "APPROVED");
    assert.equal(by["2026-9"].status, "CALCULATING");
    assert.equal(by["2026-10"].status, "NOT_STARTED");
    assert.equal(by["2026-11"].status, "FUTURE");
    assert.equal(by["2026-8"].approved_gross, (await stored(2026, 8)).gross, "August is fully approved");
    assert.equal(by["2026-9"].approved_gross, null, "September is calculated in part but nothing is approved: no provisional amount");
    const one = await dashboard.getMonths({ fy: 2026, store_ids: SCOPE, filters: { store_id: 9903, department_id: 9902 } });
    assert.equal(one.months.find((x) => x.month === 8).initialized, (await stored(2026, 8, "pe.store_id = ? AND pe.department_id = ?", [9903, 9902])).n);
  });

  it("a not-started month and an empty scope answer with nothing, not an error", async () => {
    const oct = await dashboard.getSummary({ year: 2026, month: 10, store_ids: SCOPE });
    assert.equal(oct.kpis.initialized, 0);
    assert.equal(oct.kpis.payroll_cost, "0.00");
    const nobody = await dashboard.getSummary({ year: 2026, month: 8, store_ids: [] });
    assert.equal(nobody.kpis.total_employees, 0, "an empty scope is fail-closed");
    const strip = await dashboard.getMonths({ fy: 2026, store_ids: [] });
    strip.months.forEach((x) => assert.equal(x.initialized, 0));
  });

  it("branch scope: another branch's employees never appear", async () => {
    const s = await dashboard.getSummary({ year: 2026, month: 8, store_ids: [9901] });
    const drill = await dashboard.getEmployees({ year: 2026, month: 8, store_ids: [9901], metric: "ALL", page_size: 200 });
    const db = await stored(2026, 8, "pe.store_id = ?", [9901]);
    assert.equal(s.kpis.total_employees, db.n);
    drill.rows.forEach((r) => assert.equal(r.location, "SCR Moolakulam"));
  });

  it("EXPLAIN: the dashboard's own statements use indexes", async () => {
    const plans = {
      monthTotals: await q(pool, `EXPLAIN SELECT pe.period_year, pe.period_month, COUNT(*) FROM payrun_employee pe
          LEFT JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
          WHERE pe.period_year BETWEEN 2026 AND 2027 AND (pe.period_year * 100 + pe.period_month) BETWEEN 202604 AND 202703
          GROUP BY pe.period_year, pe.period_month`),
      periods: await q(pool, `EXPLAIN SELECT employee_id FROM employee_employment_period WHERE employee_id IN (?)
          AND ((joined_on BETWEEN '2026-08-01' AND '2026-08-31') OR (ended_on BETWEEN '2026-08-01' AND '2026-08-31'))`, [IDS]),
      facts: await q(pool, `EXPLAIN SELECT ne.employee_id FROM new_employee ne LEFT JOIN department dep ON dep.department_id = ne.department_id WHERE ne.employee_id IN (?)`, [IDS]),
    };
    console.log(JSON.stringify(Object.fromEntries(Object.entries(plans).map(([k, rows]) => [k, rows.map((r) => ({ table: r.table, type: r.type, possible_keys: r.possible_keys, key: r.key, rows: r.rows }))]))));
    const join = plans.monthTotals.find((r) => r.table === "c");
    assert.ok(join.key, "the calculation join uses an index");
    // On a dozen rows the optimizer may prefer a scan; what matters is that a key is usable.
    // (Plans at production volume are measured separately - see docs/payroll_dashboard.md.)
    assert.ok(plans.periods[0].possible_keys, "employee_employment_period has a usable key");
    assert.match(String(plans.facts.find((r) => r.table === "ne").possible_keys), /PRIMARY/);
  });

  it("reports how many statements one summary costs", async () => {
    queries.count = 0;
    await dashboard.getSummary({ year: 2026, month: 9, store_ids: SCOPE });
    const summary = queries.count;
    queries.count = 0;
    await dashboard.getMonths({ fy: 2026, store_ids: SCOPE });
    const months = queries.count;
    queries.count = 0;
    await dashboard.getEmployees({ year: 2026, month: 9, store_ids: SCOPE, metric: "ALL" });
    console.log(JSON.stringify({ statements: { summary, months, drilldown: queries.count } }));
    assert.ok(summary < 60, `summary sent ${summary} statements`);
    assert.equal(months, 1);
  });
});
