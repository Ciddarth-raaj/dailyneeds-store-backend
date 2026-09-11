/**
 * M1 - what the employee master usecase does with the initial shift and the
 * onboarding education stage.
 *
 *   node --test usecase/employee_master_m1.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const build = require("./employee_master");

/** A repo whose transaction runs the callback and records the insert. */
function fakeRepo(store = {}) {
  return {
    withTransaction: async (fn) => fn({ query: async () => [] }),
    createEmployee: async (tx, fields) => {
      store.inserted = fields;
      return 901;
    },
    updateEmployee: async (tx, id, patch) => {
      store.patched = { id, patch };
      return Object.keys(patch);
    },
    lockEmployee: async () => ({ employee_id: 901, designation_id: 1, store_id: 1 }),
    bumpTokenValidFrom: async () => {},
  };
}
const lifecycleUsecase = { reconcileEmployee: async () => ({ action: "open_initial" }) };
const lifecycleRepo = {
  getLatestPeriod: async () => [],
  recordEvent: async () => {},
  insertEvent: async () => {},
};

const usecaseWith = (store, workShifts) =>
  build(fakeRepo(store), lifecycleUsecase, lifecycleRepo, null, workShifts);

const base = { employee_name: "A", date_of_joining: "2026-01-05", store_id: 1, designation_id: 1, department_id: 1 };

test("a create with no shift stores no shift column", async () => {
  const store = {};
  const usecase = usecaseWith(store, { getActiveWorkShift: async () => null });
  try {
    await usecase.createEmployee({ ...base });
  } catch (err) {
    // The reconciler fake is minimal; what matters is what reached the insert.
  }
  assert.ok(store.inserted, "the insert happened");
  assert.ok(!("default_work_shift_id" in store.inserted));
  assert.ok(!("shift_id" in store.inserted), "the legacy column is never invented");
});

test("null means not chosen, and is not stored", async () => {
  const store = {};
  const usecase = usecaseWith(store, { getActiveWorkShift: async () => null });
  try {
    await usecase.createEmployee({ ...base, default_work_shift_id: null });
  } catch (err) {}
  assert.ok(!("default_work_shift_id" in store.inserted));
});

test("an active NEW-master shift is checked first and stored on the create", async () => {
  const store = {};
  const asked = [];
  const usecase = usecaseWith(store, {
    getActiveWorkShift: async (id) => {
      asked.push(id);
      return { work_shift_id: id, active: 1 };
    },
  });
  try {
    await usecase.createEmployee({ ...base, default_work_shift_id: 7 });
  } catch (err) {}
  assert.deepEqual(asked, [7]);
  assert.equal(store.inserted.default_work_shift_id, 7);
});

test("an unknown shift is refused BEFORE anything is written", async () => {
  const store = {};
  const usecase = usecaseWith(store, { getActiveWorkShift: async () => null });
  await assert.rejects(usecase.createEmployee({ ...base, default_work_shift_id: 99 }), /does not exist/);
  assert.equal(store.inserted, undefined);
});

test("an inactive shift is refused, exactly as Employee Shift Assignment refuses it", async () => {
  const store = {};
  const usecase = usecaseWith(store, { getActiveWorkShift: async () => ({ active: 0 }) });
  await assert.rejects(usecase.createEmployee({ ...base, default_work_shift_id: 3 }), /inactive/);
  assert.equal(store.inserted, undefined);
});

test("without a shift lookup a create naming a shift is refused rather than trusted", async () => {
  const store = {};
  const usecase = usecaseWith(store, null);
  await assert.rejects(usecase.createEmployee({ ...base, default_work_shift_id: 3 }), /not configured/);
});

test("onboarding education writes the three education columns and nothing else", async () => {
  const store = {};
  const usecase = usecaseWith(store, null);
  try {
    await usecase.saveOnboardingEducation(901, {
      qualification: "B.Com",
      previous_experience: "2 years",
      store_id: 5,
      salary: 1,
    });
  } catch (err) {
    // the lifecycle fake may not satisfy the edit's tail; the patch is what matters
  }
  assert.deepEqual(store.patched, { id: 901, patch: { qualification: "B.Com", previous_experience: "2 years" } });
});

test("an empty education stage is 'nothing to change', never an empty UPDATE", async () => {
  const usecase = usecaseWith({}, null);
  await assert.rejects(usecase.saveOnboardingEducation(901, {}), /nothing to change/);
});
