/**
 * EXTRA BREAK HOURS ON THE EMPLOYEE MASTER - the field, not the arithmetic.
 *
 *   node --test usecase/employee_extra_break_master.test.js
 *
 * What is held here: an edit saves the value and preserves it, a blank clears
 * it, an impossible value is refused before anything is written, and the
 * Employee Master report exposes the column through the catalogue every other
 * Employee Master field goes through - not by a report screen's own list.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./employee_master");
const { EDITABLE_FIELDS } = require("../repository/employee_master");
const { EMPLOYEE_MASTER_COLUMNS } = require("../repository/employee");
const catalogue = require("../constants/employee_report_catalogue");

function fakeRepo(store = {}) {
  store.employees =
    store.employees || new Map([[901, { employee_id: 901, extra_break_hours: null }]]);
  return {
    store,
    withTransaction: async (fn) => fn({ query: async () => [] }),
    lockEmployee: async (tx, id) => store.employees.get(id) || null,
    updateEmployee: async (tx, id, patch) => {
      const row = store.employees.get(id);
      Object.assign(row, patch);
      return 1;
    },
    bumpTokenValidFrom: async () => {},
  };
}

const usecase = (store) =>
  build(fakeRepo(store), { reconcileEmployee: async () => ({ action: "open_initial" }) }, {
    getLatestPeriod: async () => [],
    recordEvent: async () => {},
    insertEvent: async () => {},
  }, null);

describe("the column exists everywhere an Employee Master field must", () => {
  it("is editable under the ordinary employee_edit path, with no permission of its own", () => {
    assert.ok(EDITABLE_FIELDS.includes("extra_break_hours"));
  });

  it("is part of the Employee Master's own result contract", () => {
    assert.ok(EMPLOYEE_MASTER_COLUMNS.includes("new_employee.extra_break_hours"));
  });
});

describe("editing it", () => {
  it("saves a decimal and preserves it", async () => {
    const store = {};
    const uc = usecase(store);
    await uc.editEmployee(901, { extra_break_hours: 0.5 });
    assert.equal(store.employees.get(901).extra_break_hours, 0.5);

    // An unrelated edit afterwards leaves the value alone.
    await uc.editEmployee(901, { qualification: "B.Com" });
    assert.equal(store.employees.get(901).extra_break_hours, 0.5);
  });

  it("accepts the value as text, as a form sends it", async () => {
    const store = {};
    await usecase(store).editEmployee(901, { extra_break_hours: "1.25" });
    assert.equal(store.employees.get(901).extra_break_hours, 1.25);
  });

  it("clears it on a blank, which is no extra break rather than an error", async () => {
    const store = { employees: new Map([[901, { employee_id: 901, extra_break_hours: 0.5 }]]) };
    await usecase(store).editEmployee(901, { extra_break_hours: "" });
    assert.equal(store.employees.get(901).extra_break_hours, null);
  });

  it("refuses a negative, a non-number and more than a whole day, writing nothing", async () => {
    const store = {};
    const uc = usecase(store);
    for (const bad of [-1, "half an hour", 48]) {
      await assert.rejects(() => uc.editEmployee(901, { extra_break_hours: bad }));
    }
    assert.equal(store.employees.get(901).extra_break_hours, null);
  });

  it("does not invent a value for an edit that never mentions it", async () => {
    const store = {};
    await usecase(store).editEmployee(901, { qualification: "B.Sc" });
    assert.equal("extra_break_hours" in store.employees.get(901), true);
    assert.equal(store.employees.get(901).extra_break_hours, null);
  });
});

describe("creating an employee with one", () => {
  /** The create path, with only the collaborators it actually reaches. */
  function createRepo(captured) {
    return {
      withTransaction: async (fn) => fn({ query: async () => [] }),
      createEmployee: async (tx, fields) => {
        captured.fields = fields;
        return 1234;
      },
      appendShiftAssignment: async () => {},
      lockEmployee: async () => ({ employee_id: 1234 }),
      updateEmployee: async () => 1,
      bumpTokenValidFrom: async () => {},
    };
  }

  const PERSONAL = {
    employee_name: "A Person",
    father_name: "Their Parent",
    dob: "1995-01-01",
    gender: "Male",
    marital_status: "Single",
    primary_contact_number: "9000000000",
    alternate_contact_number: "9000000001",
    permanent_address: "1 Street",
    residential_address: "1 Street",
    date_of_joining: "2026-01-01",
    store_id: 1,
    department_id: 1,
    designation_id: 1,
  };

  const createUsecase = (captured) =>
    build(createRepo(captured), { reconcileEmployee: async () => ({ action: "open_initial" }) }, {
      getLatestPeriod: async () => [],
      recordEvent: async () => {},
      insertEvent: async () => {},
    }, null);

  it("stores the value the Add Employee form supplied", async () => {
    const captured = {};
    await createUsecase(captured).createEmployee({ ...PERSONAL, extra_break_hours: "0.5" });
    assert.equal(captured.fields.extra_break_hours, 0.5);
  });

  it("stores nothing at all when the form left it blank", async () => {
    const captured = {};
    await createUsecase(captured).createEmployee({ ...PERSONAL, extra_break_hours: "" });
    assert.equal(captured.fields.extra_break_hours, null);

    const untouched = {};
    await createUsecase(untouched).createEmployee({ ...PERSONAL });
    assert.equal("extra_break_hours" in untouched.fields, false);
  });

  it("refuses an impossible value before anything is inserted", async () => {
    const captured = {};
    await assert.rejects(() =>
      createUsecase(captured).createEmployee({ ...PERSONAL, extra_break_hours: -3 })
    );
    assert.equal(captured.fields, undefined);
  });
});

describe("the Employee Master report", () => {
  const field = catalogue.FIELDS.find((f) => f.key === "extra_break_hours");

  it("exposes it as a selectable Employment column through the catalogue", () => {
    assert.ok(field, "the catalogue must own the column, not one report screen");
    assert.equal(field.label, "Extra Break Hours");
    assert.equal(field.group, "Employment");
    assert.equal(field.enabled, true);
    assert.equal(field.select, "new_employee.extra_break_hours");
    assert.equal(field.join_footprint, "base");
  });

  it("needs no permission of its own and is not a sensitive field", () => {
    assert.equal(field.permission, undefined);
    assert.ok(!field.sensitive);
  });

  it("exports the hours as stored, and a blank for an employee who has none", () => {
    assert.equal(field.transform("0.50"), "0.50");
    assert.equal(field.transform(null), null, "NULL is blank and never 0");
  });

  it("is filterable, like every other column a user may see", () => {
    assert.ok(field.filter);
    assert.equal(field.filter.type, catalogue.FILTER.ID);
  });
});
