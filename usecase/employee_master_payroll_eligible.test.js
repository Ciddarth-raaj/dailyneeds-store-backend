/**
 * `Payroll Eligible` (Salary Not Applicable) on the Employee Master - who may
 * change it, what changing it touches, and through which doors it is NOT
 * reachable. Built on the same shape as Attendance Required.
 *
 *   node --test usecase/employee_master_payroll_eligible.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./employee_master");
const { EDITABLE_FIELDS } = require("../repository/employee_master");
const { isPersonalDetailsWrite } = require("../utils/personal_details");

function fakeRepo(store = {}) {
  store.employees = store.employees || new Map([[901, { employee_id: 901, payroll_eligible: 1 }]]);
  return {
    store,
    withTransaction: async (fn) => fn({ query: async () => [] }),
    lockEmployee: async (tx, id) => store.employees.get(id) || null,
    getPayrollEligible: async (id) => {
      const e = store.employees.get(id);
      return e
        ? { employee_id: id, employee_name: "X", payroll_eligible: Number(e.payroll_eligible) === 1 }
        : null;
    },
    setPayrollEligible: async (tx, id, required) => {
      const e = store.employees.get(id);
      const before = Number(e.payroll_eligible);
      e.payroll_eligible = required ? 1 : 0;
      return { matched: 1, changed: before === (required ? 1 : 0) ? 0 : 1 };
    },
    updateEmployee: async () => [],
    bumpTokenValidFrom: async () => {},
  };
}

const usecase = (store) =>
  build(fakeRepo(store), { reconcileEmployee: async () => ({ action: "open_initial" }) }, {
    getLatestPeriod: async () => [],
    recordEvent: async () => {},
    insertEvent: async () => {},
  }, null);

describe("the default", () => {
  it("is Yes - the column is NOT NULL DEFAULT 1, so every existing employee stays in payroll", async () => {
    const uc = usecase();
    assert.equal((await uc.getPayrollEligible(901)).payroll_eligible, true);
  });
});

describe("setting it", () => {
  it("turns it off and on, and says whether anything actually changed", async () => {
    const store = {};
    const uc = usecase(store);
    const off = await uc.setPayrollEligible(901, false);
    assert.equal(off.payroll_eligible, false);
    assert.equal(off.changed, true);
    assert.equal(store.employees.get(901).payroll_eligible, 0);

    const again = await uc.setPayrollEligible(901, false);
    assert.equal(again.changed, false, "a no-op is a success, not an error");
  });

  it("does NOT touch status, resignation date or anything else on the row", async () => {
    const store = {
      employees: new Map([
        [901, { employee_id: 901, payroll_eligible: 1, status: 1, resignation_date: null, salary: "26000" }],
      ]),
    };
    await usecase(store).setPayrollEligible(901, false);
    const e = store.employees.get(901);
    assert.equal(e.status, 1, "Salary Not Applicable is NOT inactive");
    assert.equal(e.resignation_date, null, "Salary Not Applicable is NOT resigned");
    assert.equal(e.salary, "26000", "no salary record is touched");
  });

  it("refuses anything that is not a boolean", async () => {
    const uc = usecase();
    for (const bad of ["yes", 1, 0, null, undefined, {}]) {
      await assert.rejects(() => uc.setPayrollEligible(901, bad), /must be true or false/);
    }
  });

  it("404s an employee who does not exist", async () => {
    await assert.rejects(() => usecase().setPayrollEligible(404404, false), /does not exist/);
  });
});

describe("the doors it is NOT reachable through", () => {
  it("is absent from EDITABLE_FIELDS, so the employee_edit route refuses it by name", () => {
    assert.ok(!EDITABLE_FIELDS.includes("payroll_eligible"));
  });

  it("and the generic edit path says so rather than silently dropping it", async () => {
    await assert.rejects(
      () => usecase().editEmployee(901, { payroll_eligible: 0 }),
      /not an editable employee field: payroll_eligible/
    );
  });

  it("is not a Personal Details field either, so a personal save cannot carry it", () => {
    assert.equal(isPersonalDetailsWrite({ payroll_eligible: 0 }), false);
  });
});

describe("the write is administrators only, on its own route", () => {
  const fs = require("fs");
  const path = require("path");
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes/employee_master.js"), "utf8");

  it("POST /employee/:id/payroll-eligible is behind requireAdmin, and the body takes only the boolean", () => {
    const post = routes.slice(routes.indexOf('"/employee/:employee_id/payroll-eligible",\n      requireAdmin'));
    assert.ok(post.length > 0, "the POST route is declared with requireAdmin");
    assert.match(post.slice(0, 900), /payroll_eligible: Joi\.boolean\(\)\.required\(\)\s*\}\)\.unknown\(false\)/);
  });

  it("the read is an ordinary view_employees read", () => {
    const get = routes.slice(routes.indexOf('router.get(\n      "/employee/:employee_id/payroll-eligible"'));
    assert.match(get.slice(0, 300), /this\.permissions\.require\(P\.VIEW_EMPLOYEES\)/);
  });
});
