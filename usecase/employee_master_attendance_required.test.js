/**
 * `Attendance Required` on the Employee Master - who may change it, and
 * through which doors it is NOT reachable.
 *
 *   node --test usecase/employee_master_attendance_required.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./employee_master");
const { EDITABLE_FIELDS } = require("../repository/employee_master");
const { isPersonalDetailsWrite } = require("../utils/personal_details");

function fakeRepo(store = {}) {
  store.employees = store.employees || new Map([[901, { employee_id: 901, attendance_required: 1 }]]);
  return {
    store,
    withTransaction: async (fn) => fn({ query: async () => [] }),
    lockEmployee: async (tx, id) => store.employees.get(id) || null,
    getAttendanceRequired: async (id) => {
      const e = store.employees.get(id);
      return e
        ? { employee_id: id, employee_name: "X", attendance_required: Number(e.attendance_required) === 1 }
        : null;
    },
    setAttendanceRequired: async (tx, id, required) => {
      const e = store.employees.get(id);
      const before = Number(e.attendance_required);
      e.attendance_required = required ? 1 : 0;
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
  it("is Yes - the column is NOT NULL DEFAULT 1, so an existing row reads true", async () => {
    const uc = usecase();
    assert.equal((await uc.getAttendanceRequired(901)).attendance_required, true);
  });
});

describe("setting it", () => {
  it("turns it off and on, and says whether anything actually changed", async () => {
    const store = {};
    const uc = usecase(store);
    const off = await uc.setAttendanceRequired(901, false);
    assert.equal(off.attendance_required, false);
    assert.equal(off.changed, true);
    assert.equal(store.employees.get(901).attendance_required, 0);

    const again = await uc.setAttendanceRequired(901, false);
    assert.equal(again.changed, false, "a no-op is a success, not an error");
  });

  it("does NOT touch status, resignation date or anything else on the row", async () => {
    const store = {
      employees: new Map([
        [901, { employee_id: 901, attendance_required: 1, status: 1, resignation_date: null, salary: "26000" }],
      ]),
    };
    await usecase(store).setAttendanceRequired(901, false);
    const e = store.employees.get(901);
    assert.equal(e.status, 1, "exempt is NOT inactive");
    assert.equal(e.resignation_date, null, "exempt is NOT resigned");
    assert.equal(e.salary, "26000", "exempt is NOT a salary stop");
  });

  it("refuses anything that is not a boolean", async () => {
    const uc = usecase();
    for (const bad of ["yes", 1, 0, null, undefined, {}]) {
      await assert.rejects(() => uc.setAttendanceRequired(901, bad), /must be true or false/);
    }
  });

  it("404s an employee who does not exist", async () => {
    await assert.rejects(() => usecase().setAttendanceRequired(404404, false), /does not exist/);
  });
});

describe("the doors it is NOT reachable through", () => {
  it("is absent from EDITABLE_FIELDS, so the employee_edit route refuses it by name", () => {
    assert.ok(!EDITABLE_FIELDS.includes("attendance_required"));
  });

  it("and the generic edit path says so rather than silently dropping it", async () => {
    await assert.rejects(
      () => usecase().editEmployee(901, { attendance_required: 0 }),
      /not an editable employee field: attendance_required/
    );
  });

  it("is not a Personal Details field either, so a personal save cannot carry it", () => {
    assert.equal(isPersonalDetailsWrite({ attendance_required: 0 }), false);
  });
});
