/**
 * `Duty Location` on the Employee Master - who may change it, what it moves,
 * and through which doors it is NOT reachable.
 *
 *   node --test usecase/employee_master_location_scope.test.js
 *
 * The shape follows `employee_master_attendance_required.test.js`, because
 * this is the same kind of field: a single operational fact that HR may see
 * and may not change, with its own endpoint and no way in through the generic
 * edit.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const build = require("./employee_master");
const { EDITABLE_FIELDS } = require("../repository/employee_master");

function fakeRepo(store = {}) {
  store.employees =
    store.employees ||
    new Map([[901, { employee_id: 901, store_id: 9, works_all_locations: 0 }]]);
  return {
    store,
    withTransaction: async (fn) => fn({ query: async () => [] }),
    lockEmployee: async (tx, id) => store.employees.get(id) || null,
    getWorksAllLocations: async (id) => {
      const e = store.employees.get(id);
      return e
        ? {
            employee_id: id,
            employee_name: "X",
            store_id: e.store_id === undefined ? null : e.store_id,
            works_all_locations: Number(e.works_all_locations) === 1,
          }
        : null;
    },
    setWorksAllLocations: async (tx, id, roaming) => {
      const e = store.employees.get(id);
      const before = Number(e.works_all_locations);
      e.works_all_locations = roaming ? 1 : 0;
      return { matched: 1, changed: before === (roaming ? 1 : 0) ? 0 : 1 };
    },
    updateEmployee: async () => [],
    bumpTokenValidFrom: async () => {},
  };
}

const usecase = (store) =>
  build(
    fakeRepo(store),
    { reconcileEmployee: async () => ({ action: "open_initial" }) },
    { getLatestPeriod: async () => [], recordEvent: async () => {}, insertEvent: async () => {} },
    null
  );

describe("the default", () => {
  it("is a FIXED outlet - the column is NOT NULL DEFAULT 0", async () => {
    assert.equal((await usecase().getWorksAllLocations(901)).works_all_locations, false);
  });
});

describe("setting it", () => {
  it("turns it on and off, and says whether anything actually changed", async () => {
    const store = {};
    const uc = usecase(store);
    const on = await uc.setWorksAllLocations(901, true);
    assert.equal(on.works_all_locations, true);
    assert.equal(on.changed, true);
    assert.equal(store.employees.get(901).works_all_locations, 1);

    const again = await uc.setWorksAllLocations(901, true);
    assert.equal(again.changed, false, "a no-op is a success, not an error");
  });

  /**
   * THE OWNING BRANCH SURVIVES, and this is the load-bearing part. Every
   * branch authorization scope in this system reads `store_id`; clearing it
   * for somebody who roams would make that person invisible to their own
   * manager, which is a far worse fault than the staffing gap this fixes.
   */
  it("does NOT clear store_id, or touch status, resignation date or salary", async () => {
    const store = {
      employees: new Map([
        [
          901,
          {
            employee_id: 901,
            store_id: 9,
            works_all_locations: 0,
            status: 1,
            resignation_date: null,
            salary: "26000",
            attendance_required: 1,
          },
        ],
      ]),
    };
    await usecase(store).setWorksAllLocations(901, true);
    const after = store.employees.get(901);
    assert.equal(after.store_id, 9, "the branch that owns the record is untouched");
    assert.equal(after.status, 1);
    assert.equal(after.resignation_date, null);
    assert.equal(after.salary, "26000");
    assert.equal(after.attendance_required, 1, "this is not an attendance exemption");
  });

  it("refuses anything that is not a boolean", async () => {
    const uc = usecase();
    for (const v of ["yes", 1, null, undefined, {}]) {
      await assert.rejects(() => uc.setWorksAllLocations(901, v), /must be true or false/);
    }
  });

  it("refuses an employee that does not exist", async () => {
    await assert.rejects(() => usecase().setWorksAllLocations(404, true), /does not exist/);
  });
});

describe("the doors it is NOT reachable through", () => {
  it("is absent from EDITABLE_FIELDS, so the generic edit refuses it by name", () => {
    assert.ok(!EDITABLE_FIELDS.includes("works_all_locations"));
  });

  it("the write route is administrators only, not a grantable permission key", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "employee_master.js"), "utf8");
    const block = routes.slice(routes.indexOf('router.post(\n      "/employee/:employee_id/location-scope"'));
    const head = block.slice(0, 400);
    assert.match(head, /requireAdmin/);
    assert.ok(!/permissions\.require/.test(head), "a permission key would be grantable to HR");
  });

  it("the read route is an ordinary employee-master read", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "employee_master.js"), "utf8");
    const block = routes.slice(routes.indexOf('router.get(\n      "/employee/:employee_id/location-scope"'));
    assert.match(block.slice(0, 300), /VIEW_EMPLOYEES/);
  });
});
