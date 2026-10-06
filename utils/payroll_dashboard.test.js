/**
 * Payroll Dashboard - the pure rules.
 *
 *   node --test utils/payroll_dashboard.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const D = require("./payroll_dashboard");

const MONTH = { year: 2026, month: 8 };

/* A calculation-stage row (initialized; attributed by its snapshot). */
const calc = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Calc ${id}`,
  store_id: 1,
  location: "Moolakulam",
  department_id: 10,
  department_name: "Billing",
  designation_id: 100,
  designation_name: "Cashier",
  date_of_joining: "2020-01-01",
  resignation_date: null,
  status: "READY_FOR_APPROVAL",
  status_label: "Ready for approval",
  blockers: [],
  recalculation_reasons: [],
  attendance_needs_action: false,
  statutory_hold: null,
  figures: { gross: "20000.00", deductions: "1500.50", net: "18499.50", pf: "1200.00", esi: "150.50", advance: "100.00", shortage: "50.00", missing_hours: "0.00" },
  ...over,
});

/* An initialization-stage row (live master). */
const init = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Init ${id}`,
  store_id: 1,
  store_name: "Moolakulam",
  designation_id: 100,
  designation_name: "Cashier",
  date_of_joining: "2020-01-01",
  resignation_date: null,
  status: "READY",
  initialized: false,
  blocking_reasons: [],
  exited_in_month: false,
  ...over,
});

const facts = (list) => list.map(([employee_id, department_id, department_name, employment_type]) => ({ employee_id, department_id, department_name, employment_type }));

describe("money", () => {
  it("adds in paise and prints two-decimal rupees", () => {
    assert.equal(D.toPaise("0.1") + D.toPaise("0.2"), 30);
    assert.equal(D.rupees(30), "0.30");
    assert.equal(D.rupees(-1250), "-12.50");
    assert.equal(D.rupees(null), null);
    assert.equal(D.toPaise("abc"), null);
  });
});

describe("financial year and month selection", () => {
  it("runs April to March", () => {
    const months = D.financialYearMonths(2026);
    assert.equal(months.length, 12);
    assert.deepEqual(months[0], { year: 2026, month: 4 });
    assert.deepEqual(months[8], { year: 2026, month: 12 });
    assert.deepEqual(months[11], { year: 2027, month: 3 });
    assert.equal(D.financialYearOf(2027, 3), 2026);
    assert.equal(D.financialYearOf(2026, 4), 2026);
    assert.equal(D.shortLabel(2026, 4), "APR '26");
    assert.deepEqual(D.previousMonth(2026, 1), { year: 2025, month: 12 });
  });

  it("gives every month a status, empty and future months included", () => {
    const strip = D.buildMonthStrip({
      fy: 2026,
      today: { year: 2026, month: 10 },
      totals: [
        { year: 2026, month: 4, initialized: 10, calculated: 10, approved: 10, published: 10, gross: "1000.5" },
        { year: 2026, month: 5, initialized: 10, calculated: 10, approved: 10, published: 3, gross: "1000" },
        { year: 2026, month: 6, initialized: 10, calculated: 4, approved: 1, published: 0, gross: "400" },
        { year: 2026, month: 7, initialized: 10, calculated: 0, approved: 0, published: 0, gross: "0" },
      ],
    });
    const status = Object.fromEntries(strip.map((m) => [m.label, m.status]));
    assert.equal(status["APR '26"], "PUBLISHED");
    assert.equal(status["MAY '26"], "APPROVED");
    assert.equal(status["JUN '26"], "CALCULATING");
    assert.equal(status["JUL '26"], "INITIALIZED");
    assert.equal(status["AUG '26"], "NOT_STARTED");
    assert.equal(status["OCT '26"], "NOT_STARTED");
    assert.equal(status["NOV '26"], "FUTURE");
    assert.equal(strip[0].gross, "1000.50");
    assert.equal(strip[3].gross, null, "nothing calculated: no amount, not a zero");
    assert.equal(strip[4].gross, null);
  });
});

describe("merging the two stages", () => {
  it("takes initialized employees from the calculation stage and the rest from initialization", () => {
    const rows = D.mergeMonth({
      ...MONTH,
      calcRows: [calc(1)],
      initRows: [init(1, { status: "INITIALIZED", initialized: true, store_id: 9 }), init(2)],
      facts: facts([[2, 20, "Stores", "Contract"], [1, 99, "Live dept", "Permanent"]]),
    });
    assert.equal(rows.length, 2);
    const one = rows.find((r) => r.employee_id === 1);
    assert.equal(one.store_id, 1, "the snapshot's location, as Calculation & Review shows it");
    assert.equal(one.department_id, 10, "the snapshot's department");
    assert.equal(one.employment_type, "Permanent");
    const two = rows.find((r) => r.employee_id === 2);
    assert.equal(two.initialized, false);
    assert.equal(two.department_id, 20);
    assert.equal(two.department_name, "Stores");
  });

  it("drops an initialized employee the calculation stage did not return (snapshot outside the scope)", () => {
    const rows = D.mergeMonth({
      ...MONTH,
      calcRows: [],
      initRows: [init(1, { status: "INITIALIZED", initialized: true })],
    });
    assert.deepEqual(rows, []);
  });

  it("classifies joined, rejoined and resigned by the month's dates", () => {
    const rows = D.mergeMonth({
      ...MONTH,
      calcRows: [
        calc(1, { date_of_joining: "2026-08-10" }),
        calc(2, { date_of_joining: "2026-08-03" }),
        calc(3, { resignation_date: "2026-08-20" }),
        calc(4, { date_of_joining: "2026-07-31" }),
      ],
      initRows: [init(5, { date_of_joining: "2026-08-31", exited_in_month: false }), init(6, { exited_in_month: true })],
      rejoins: [{ employee_id: 2, joined_on: "2026-08-03" }],
    });
    const m = (id) => rows.find((r) => r.employee_id === id).movement;
    assert.deepEqual(m(1), { joined: true, rejoined: false, resigned: false });
    assert.deepEqual(m(2), { joined: false, rejoined: true, resigned: false });
    assert.equal(m(3).resigned, true);
    assert.equal(m(4).joined, false);
    assert.equal(m(5).joined, true);
    assert.equal(m(6).resigned, true, "the initialization stage's dated exit is used as it is");
  });

  it("leaves figures out while the review screen presents none", () => {
    const rows = D.mergeMonth({ ...MONTH, calcRows: [calc(1, { figures: null }), calc(2, { figures: { net: null } })] });
    rows.forEach((r) => assert.equal(r.figures, null));
  });
});

/* A month across two locations, two departments, three designations. */
function month() {
  return D.mergeMonth({
    ...MONTH,
    calcRows: [
      calc(1),
      calc(2, { designation_id: 101, designation_name: "Packer" }),
      calc(3, { store_id: 2, location: "ECR", department_id: 11, department_name: "Stores", designation_id: 102, designation_name: "Loader" }),
      calc(4, { store_id: 2, location: "ECR", status: "NOT_CALCULATED", status_label: "Not calculated", figures: null, blockers: [{ code: "NOT_CALCULATED", label: "Not calculated" }] }),
    ],
    initRows: [
      init(5, { store_id: 2, store_name: "ECR", designation_id: 102, designation_name: "Loader", status: "BLOCKED", blocking_reasons: [{ code: "SALARY_NOT_APPROVED", label: "Salary not approved" }] }),
    ],
    facts: facts([[5, 11, "Stores", "Contract"], [1, 10, "Billing", "Permanent"], [2, 10, "Billing", "Permanent"], [3, 11, "Stores", "Contract"], [4, 10, "Billing", "Permanent"]]),
  });
}

describe("filters", () => {
  it("location", () => {
    assert.deepEqual(D.applyFilters(month(), { store_id: 2 }).map((r) => r.employee_id).sort(), [3, 4, 5]);
  });
  it("department", () => {
    assert.deepEqual(D.applyFilters(month(), { department_id: 11 }).map((r) => r.employee_id).sort(), [3, 5]);
  });
  it("designation", () => {
    assert.deepEqual(D.applyFilters(month(), { designation_id: 101 }).map((r) => r.employee_id), [2]);
  });
  it("combined, and All when empty", () => {
    assert.deepEqual(D.applyFilters(month(), { store_id: 2, department_id: 10 }).map((r) => r.employee_id), [4]);
    assert.deepEqual(D.applyFilters(month(), { store_id: 1, department_id: 11 }), []);
    assert.equal(D.applyFilters(month(), { store_id: "", department_id: null }).length, 5);
  });

  it("offers dependent choices", () => {
    const all = D.filterOptions(month(), {});
    assert.deepEqual(all.locations.map((o) => [o.id, o.count]), [[2, 3], [1, 2]]);
    assert.equal(all.departments.length, 2);
    assert.equal(all.designations.length, 3);

    const atMoolakulam = D.filterOptions(month(), { store_id: 1 });
    assert.deepEqual(atMoolakulam.departments.map((o) => o.id), [10]);
    assert.deepEqual(atMoolakulam.designations.map((o) => o.id).sort(), [100, 101]);
    assert.equal(atMoolakulam.locations.length, 2, "the location list itself is not narrowed by its own choice");

    const ecrStores = D.filterOptions(month(), { store_id: 2, department_id: 11 });
    assert.deepEqual(ecrStores.designations.map((o) => o.id), [102]);
  });

  it("keeps a stale selection visible so it can be cleared", () => {
    const o = D.filterOptions(month(), { store_id: 1, department_id: 11 });
    assert.ok(o.departments.some((d) => d.id === 11 && d.count === 0));
  });
});

describe("KPIs, head count and the deduction breakdown", () => {
  it("totals the month", () => {
    const k = D.kpis(month());
    assert.equal(k.total_employees, 5);
    assert.equal(k.initialized, 4);
    assert.equal(k.not_initialized, 1);
    assert.equal(k.payroll_cost, "60000.00");
    assert.equal(k.total_deductions, "4501.50");
    assert.equal(k.net_payable, "55498.50");
    assert.equal(k.costed_employees, 3);
    assert.equal(k.uncosted_initialized, 1);
  });

  it("totals only what the filters select", () => {
    const k = D.kpis(D.applyFilters(month(), { store_id: 2 }));
    assert.equal(k.total_employees, 3);
    assert.equal(k.payroll_cost, "20000.00");
  });

  it("counts heads by every grouping", () => {
    const h = D.headcount(month());
    assert.deepEqual(h.location.map((g) => [g.id, g.count]), [["2", 3], ["1", 2]]);
    assert.deepEqual(h.employment_type.map((g) => [g.id, g.count]), [["Permanent", 3], ["Contract", 2]]);
    assert.equal(h.designation.find((g) => g.id === "102").count, 2);
  });

  it("buckets an unset grouping as Not set", () => {
    const rows = D.mergeMonth({ ...MONTH, calcRows: [calc(1, { department_id: null })] });
    const h = D.headcount(rows);
    assert.deepEqual(h.department.map((g) => [g.id, g.name]), [[D.NONE, "Not set"]]);
    assert.equal(D.selectRows(rows, { metric: "HEADCOUNT", group_by: "department", group_id: D.NONE }).length, 1);
  });

  it("breaks deductions down, with PT and TDS not tracked rather than zero", () => {
    const e = D.earnings(month());
    const b = Object.fromEntries(e.breakdown.map((x) => [x.key, x]));
    assert.equal(b.PF.amount, "3600.00");
    assert.equal(b.ESI.amount, "451.50");
    assert.equal(b.ADVANCE.amount, "300.00");
    assert.equal(b.OTHER.amount, "150.00");
    assert.equal(b.PT.tracked, false);
    assert.equal(b.PT.amount, null);
    assert.equal(b.IT.amount, null);
    const parts = ["PF", "ESI", "ADVANCE", "OTHER"].reduce((s, k) => s + D.toPaise(b[k].amount), 0);
    assert.equal(D.rupees(parts), e.deductions, "the tracked parts add up to the total");
  });
});

describe("payroll comparison", () => {
  it("compares the selected month with another, with differences and direction", () => {
    const base = month();
    const other = D.mergeMonth({ year: 2026, month: 7, calcRows: [calc(1)], initRows: [] });
    const c = D.comparison(base, other, MONTH, { year: 2026, month: 7 });
    const m = Object.fromEntries(c.metrics.map((x) => [x.key, x]));
    assert.equal(c.base.label, "August 2026");
    assert.equal(c.compare.label, "July 2026");
    assert.deepEqual([m.EMPLOYEE_COUNT.base, m.EMPLOYEE_COUNT.compare, m.EMPLOYEE_COUNT.difference], [5, 1, 4]);
    assert.deepEqual([m.GROSS.base, m.GROSS.compare, m.GROSS.difference], ["60000.00", "20000.00", "40000.00"]);
    assert.equal(m.GROSS.percent, 200);
    assert.equal(m.PT.tracked, false);
    assert.equal(m.IT.base, null);
  });

  it("handles a comparison month that has not started", () => {
    const c = D.comparison(month(), [], MONTH, { year: 2026, month: 9 });
    const gross = c.metrics.find((x) => x.key === "GROSS");
    assert.equal(gross.compare, "0.00");
    assert.equal(gross.percent, null, "no percentage against nothing");
  });

  it("respects the filters on both sides", () => {
    const f = { store_id: 2 };
    const c = D.comparison(D.applyFilters(month(), f), D.applyFilters(month(), f), MONTH, MONTH);
    assert.equal(c.metrics.find((x) => x.key === "EMPLOYEE_COUNT").base, 3);
    assert.equal(c.metrics.find((x) => x.key === "GROSS").difference, "0.00");
  });
});

describe("people movement", () => {
  it("counts and costs each category", () => {
    const rows = D.mergeMonth({
      ...MONTH,
      calcRows: [calc(1, { date_of_joining: "2026-08-10" }), calc(2, { resignation_date: "2026-08-05" }), calc(3, { date_of_joining: "2026-08-02" })],
      initRows: [init(4, { date_of_joining: "2026-08-25" })],
      rejoins: [{ employee_id: 3 }],
    });
    const mv = Object.fromEntries(D.peopleMovement(rows).map((m) => [m.key, m]));
    assert.equal(mv.JOINED.count, 2);
    assert.equal(mv.JOINED.costed_employees, 1);
    assert.equal(mv.JOINED.payroll_cost, "20000.00");
    assert.equal(mv.REJOINED.count, 1);
    assert.equal(mv.RESIGNED.count, 1);
    assert.equal(mv.RESIGNED.net_wages, "18499.50");
    assert.deepEqual(D.selectRows(rows, { metric: "MOVE_JOINED" }).map((r) => r.employee_id).sort(), [1, 4]);
  });
});

describe("action required", () => {
  const rows = () =>
    D.mergeMonth({
      ...MONTH,
      calcRows: [
        calc(1, { status: "NOT_CALCULATED", figures: null, blockers: [{ code: "NOT_CALCULATED" }] }),
        calc(2, { status: "ATTENDANCE_PENDING", attendance_needs_action: true, figures: null }),
        calc(3, { status: "RECALCULATION_REQUIRED", recalculation_reasons: [{ code: "CALCULATION_FAILED", label: "Calculation did not complete" }] }),
        calc(4, { status: "CALCULATED", blockers: [{ code: "ADJUSTMENT_PENDING_CONFIRMATION" }, { code: "CALCULATION_INCOMPLETE" }] }),
        calc(5, { status: "CALCULATED", statutory_hold: { code: "STATUTORY_SETUP_INCOMPLETE" } }),
        calc(6, { figures: { gross: "100", deductions: "300", net: "-200" } }),
        calc(7),
      ],
      initRows: [
        init(8),
        init(9, { status: "BLOCKED", blocking_reasons: [{ code: "SALARY_NOT_APPROVED" }, { code: "STATUTORY_SETUP_INCOMPLETE" }] }),
      ],
    });

  it("counts only what the payrun stages already decided", () => {
    const items = Object.fromEntries(D.actionItems(rows()).map((a) => [a.key, a]));
    assert.equal(items.NOT_INITIALIZED_READY.count, 1);
    assert.equal(items.SALARY_NOT_APPROVED.count, 1);
    assert.equal(items.STATUTORY_SETUP.count, 2);
    assert.equal(items.ATTENDANCE_NEEDS_ACTION.count, 1);
    assert.equal(items.ADJUSTMENT_PENDING.count, 1);
    assert.equal(items.NOT_CALCULATED.count, 1);
    assert.equal(items.RECALCULATION_REQUIRED.count, 1);
    assert.equal(items.CALCULATION_INCOMPLETE.count, 2);
    assert.equal(items.NEGATIVE_NET_PAY.count, 1);
    assert.equal(items.PENDING_APPROVAL.count, 2);
  });

  it("points each item at the stage and card that fixes it", () => {
    const items = Object.fromEntries(D.actionItems(rows()).map((a) => [a.key, a]));
    assert.deepEqual(items.ATTENDANCE_NEEDS_ACTION.target, { stage: "CALCULATION", card: "ATTENDANCE_NEEDS_ACTION" });
    assert.deepEqual(items.SALARY_NOT_APPROVED.target, { stage: "INITIALIZATION", card: "BLOCKED" });
    assert.equal(items.STATUTORY_SETUP.target.stage, "CALCULATION");
    const onlyInit = Object.fromEntries(D.actionItems(rows().filter((r) => !r.initialized)).map((a) => [a.key, a]));
    assert.equal(onlyInit.STATUTORY_SETUP.target.stage, "INITIALIZATION");
  });

  it("drills into exactly the affected employees", () => {
    assert.deepEqual(D.selectRows(rows(), { metric: "ACTION_NEGATIVE_NET_PAY" }).map((r) => r.employee_id), [6]);
    assert.deepEqual(D.selectRows(rows(), { metric: "ACTION_STATUTORY_SETUP" }).map((r) => r.employee_id).sort(), [5, 9]);
  });
});

describe("drill-down", () => {
  it("selects by metric and refuses an unknown one", () => {
    const rows = month();
    assert.deepEqual(D.selectRows(rows, { metric: "not_initialized" }).map((r) => r.employee_id), [5]);
    assert.equal(D.selectRows(rows, { metric: "COSTED" }).length, 3);
    assert.equal(D.selectRows(rows, { metric: "DED_PF" }).length, 3);
    assert.equal(D.selectRows(rows, { metric: "HEADCOUNT", group_by: "location", group_id: "2" }).length, 3);
    assert.equal(D.selectRows(rows, { metric: "HEADCOUNT", group_by: "salary" }), null);
    assert.equal(D.selectRows(rows, { metric: "NOPE" }), null);
    assert.equal(D.selectRows(rows, { metric: "ACTION_NOPE" }), null);
  });

  it("drills within the filters", () => {
    const rows = D.applyFilters(month(), { store_id: 1 });
    assert.deepEqual(D.selectRows(rows, { metric: "COSTED" }).map((r) => r.employee_id).sort(), [1, 2]);
  });

  it("pages, totals the whole selection and says where to fix each row", () => {
    const rows = month();
    const page = D.drilldown(rows, { page: 2, page_size: 2 });
    assert.equal(page.total, 5);
    assert.equal(page.rows.length, 2);
    assert.equal(page.totals.gross, "60000.00");
    const blocked = D.drilldown(D.selectRows(rows, { metric: "NOT_INITIALIZED" })).rows[0];
    assert.equal(blocked.stage, "INITIALIZATION");
    assert.deepEqual(blocked.reasons, ["Salary not approved"]);
    assert.equal(blocked.gross, null);
    assert.equal(D.drilldown(rows, { page_size: 5000 }).page_size, 200);
  });
});
