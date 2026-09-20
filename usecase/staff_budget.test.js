/**
 * The Staff Budget usecase - validation, and what reaches the repository.
 *
 *   node --test usecase/staff_budget.test.js
 *
 * A fake repository records every call, so these assert on behaviour that
 * matters operationally: that an invalid combination is refused BEFORE
 * anything is written, that a bulk save is all-or-nothing on validation, and
 * that the decided rates are resolved from the masters rather than guessed.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./staff_budget");

const MASTERS = {
  outlets: [
    { outlet_id: 2, outlet_name: "Daily Needs-Warehouse", is_active: 1 },
    { outlet_id: 3, outlet_name: "ECR", is_active: 1 },
  ],
  departments: [{ department_id: 1, department_name: "Sales", status: 1 }],
  designations: [
    { designation_id: 21, designation_name: "Customer Service Associate", status: 1 },
    { designation_id: 22, designation_name: "Cashier", status: 1 },
    { designation_id: 23, designation_name: "Store Keeper", status: 0 },
  ],
  // `work_shift`, the master the attendance engine resolves against. `active`
  // is its own flag; the legacy `shift_master.status` is not read anywhere.
  shifts: [
    { work_shift_id: 11, shift_code: "S96", shift_name: "9-6", in_time: "09:00:00", out_time: "18:00:00", active: 1 },
    { work_shift_id: 12, shift_code: "S99", shift_name: "9-9", in_time: "09:00:00", out_time: "21:00:00", active: 1 },
    { work_shift_id: 13, shift_code: "S1010", shift_name: "10-10", in_time: "10:00:00", out_time: "22:00:00", active: 1 },
    { work_shift_id: 14, shift_code: "S210", shift_name: "2-10", in_time: "14:00:00", out_time: "22:00:00", active: 1 },
    { work_shift_id: 15, shift_code: "S610", shift_name: "6-10", in_time: "18:00:00", out_time: "22:00:00", active: 1 },
    { work_shift_id: 16, shift_code: "SNIGHT", shift_name: "Retired night", in_time: "22:00:00", out_time: "06:00:00", active: 0 },
  ],
};

function fakeRepo(overrides = {}) {
  const calls = { upsertBudget: [], upsertRates: [], deactivate: [] };
  const repo = {
    calls,
    async getBudgetRows() {
      return overrides.rows || [];
    },
    async getMasters() {
      return MASTERS;
    },
    async checkMasters({ outlet_id, department_id, designation_id, work_shift_id }) {
      const outlet = MASTERS.outlets.find((o) => o.outlet_id === outlet_id);
      const department = MASTERS.departments.find((d) => d.department_id === department_id);
      const designation = MASTERS.designations.find((d) => d.designation_id === designation_id);
      const shift = MASTERS.shifts.find((s) => s.work_shift_id === work_shift_id);
      return {
        outlet: { found: !!outlet, active: !!outlet && outlet.is_active === 1 },
        department: { found: !!department, active: !!department && department.status === 1 },
        designation: { found: !!designation, active: !!designation && designation.status === 1 },
        shift: { found: !!shift, active: !!shift && shift.active === 1 },
      };
    },
    async upsertBudget(row, actorId) {
      calls.upsertBudget.push({ row, actorId });
      return { staff_budget_id: 100 + calls.upsertBudget.length, created: true };
    },
    async getBudgetById(id) {
      return overrides.budgetById === undefined
        ? { staff_budget_id: id, approved_headcount: 4, status: 1 }
        : overrides.budgetById;
    },
    async deactivateBudget(id, actorId) {
      calls.deactivate.push({ id, actorId });
      return overrides.deactivated === undefined ? true : overrides.deactivated;
    },
    async getHistory() {
      return overrides.history || [];
    },
    async getRates() {
      return overrides.rates || [];
    },
    async upsertRates(rates, actorId) {
      calls.upsertRates.push({ rates, actorId });
      return { created: rates.length, updated: 0, unchanged: 0 };
    },
  };
  return repo;
}

const VALID = {
  outlet_id: 3,
  department_id: 1,
  designation_id: 21,
  work_shift_id: 13,
  approved_headcount: 2,
};

describe("saving one approved headcount", () => {
  it("writes the combination and records who did it", async () => {
    const repo = fakeRepo();
    const result = await buildUsecase(repo).saveBudget(VALID, 4321);

    assert.equal(result.code, 200);
    assert.equal(repo.calls.upsertBudget.length, 1);
    assert.deepEqual(repo.calls.upsertBudget[0], {
      row: { ...VALID, approved_headcount: 2 },
      actorId: 4321,
    });
  });

  it("accepts zero - an approved headcount of none is a decision", async () => {
    const repo = fakeRepo();
    await buildUsecase(repo).saveBudget({ ...VALID, approved_headcount: 0 }, 1);
    assert.equal(repo.calls.upsertBudget[0].row.approved_headcount, 0);
  });

  it("refuses a fraction or a negative, and writes nothing", async () => {
    for (const bad of [-1, 2.5, "abc", null]) {
      const repo = fakeRepo();
      await assert.rejects(() =>
        buildUsecase(repo).saveBudget({ ...VALID, approved_headcount: bad }, 1)
      );
      assert.equal(repo.calls.upsertBudget.length, 0);
    }
  });

  it("refuses an inactive designation and names which master is wrong", async () => {
    const repo = fakeRepo();
    await assert.rejects(
      () => buildUsecase(repo).saveBudget({ ...VALID, designation_id: 23 }, 1),
      (err) => {
        assert.match(err.message, /designation is not active/);
        return true;
      }
    );
    assert.equal(repo.calls.upsertBudget.length, 0);
  });

  it("reports every bad master at once rather than one per round trip", async () => {
    const repo = fakeRepo();
    await assert.rejects(
      () =>
        buildUsecase(repo).saveBudget(
          { ...VALID, outlet_id: 999, work_shift_id: 16 },
          1
        ),
      (err) => {
        assert.equal(err.details.length, 2);
        assert.match(err.message, /location does not exist/);
        assert.match(err.message, /shift is not active/);
        return true;
      }
    );
  });

  it("allows any combination of valid masters, since no mapping master exists", async () => {
    // A Cashier budgeted under Sales at the Warehouse: unusual, but there is
    // no department <-> designation mapping in this schema to contradict it,
    // and the budget row IS the record that it was approved.
    const repo = fakeRepo();
    await buildUsecase(repo).saveBudget(
      { outlet_id: 2, department_id: 1, designation_id: 22, work_shift_id: 11, approved_headcount: 1 },
      1
    );
    assert.equal(repo.calls.upsertBudget.length, 1);
  });
});

describe("saving a designation's whole grid", () => {
  const grid = [11, 12, 13].map((work_shift_id) => ({ ...VALID, work_shift_id, approved_headcount: 1 }));

  it("writes every row", async () => {
    const repo = fakeRepo();
    const result = await buildUsecase(repo).saveBudgetBulk(grid, 7);
    assert.equal(result.saved, 3);
    assert.equal(repo.calls.upsertBudget.length, 3);
  });

  it("writes NOTHING when one row is invalid", async () => {
    const repo = fakeRepo();
    const broken = grid.concat({ ...VALID, work_shift_id: 14, approved_headcount: -2 });
    await assert.rejects(
      () => buildUsecase(repo).saveBudgetBulk(broken, 7),
      (err) => {
        assert.match(err.message, /row 4/);
        return true;
      }
    );
    assert.equal(repo.calls.upsertBudget.length, 0);
  });

  it("refuses the same combination twice in one payload", async () => {
    const repo = fakeRepo();
    await assert.rejects(
      () => buildUsecase(repo).saveBudgetBulk(grid.concat(grid[0]), 7),
      (err) => {
        assert.match(err.message, /appears twice/);
        return true;
      }
    );
    assert.equal(repo.calls.upsertBudget.length, 0);
  });

  it("refuses an empty save", async () => {
    await assert.rejects(() => buildUsecase(fakeRepo()).saveBudgetBulk([], 7));
  });
});

describe("removing a combination", () => {
  it("soft-removes it and keeps the row", async () => {
    const repo = fakeRepo();
    const result = await buildUsecase(repo).removeBudget(101, 9);
    assert.equal(result.code, 200);
    assert.deepEqual(repo.calls.deactivate, [{ id: 101, actorId: 9 }]);
  });

  it("404s on a row that does not exist", async () => {
    const repo = fakeRepo({ budgetById: null });
    const result = await buildUsecase(repo).removeBudget(999, 9);
    assert.equal(result.code, 404);
    assert.equal(repo.calls.deactivate.length, 0);
  });
});

describe("the rates", () => {
  it("writes exactly the ids the caller picked, and nothing else", async () => {
    const repo = fakeRepo();
    await buildUsecase(repo).saveRate(
      { designation_id: 21, work_shift_id: 13, monthly_rate: 14500 },
      5
    );
    assert.deepEqual(repo.calls.upsertRates[0].rates, [
      { designation_id: 21, work_shift_id: 13, monthly_rate: 14500 },
    ]);
  });

  it("offers NO action that finds a designation or a shift by itself", () => {
    // The guard against a production write choosing which master record real
    // money attaches to. Rates are picked by a person on the rate screen.
    const usecase = buildUsecase(fakeRepo());
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(usecase))) {
      assert.ok(
        !/standard|resolve|match|auto/i.test(name),
        `${name} looks like an automatic rate-resolution action`
      );
    }
  });

  it("refuses a rate on an inactive work shift", async () => {
    await assert.rejects(
      () =>
        buildUsecase(fakeRepo()).saveRate(
          { designation_id: 21, work_shift_id: 16, monthly_rate: 9000 },
          1
        ),
      (err) => {
        assert.match(err.message, /shift is not active/);
        return true;
      }
    );
  });

  it("refuses a negative rate", async () => {
    await assert.rejects(() =>
      buildUsecase(fakeRepo()).saveRate(
        { designation_id: 21, work_shift_id: 13, monthly_rate: -1 },
        1
      )
    );
  });
});

describe("reading the plan", () => {
  it("returns the hierarchy and the checkpoint definitions together", async () => {
    const rows = [
      {
        staff_budget_id: 1,
        outlet_id: 3,
        outlet_name: "ECR",
        department_id: 1,
        department_name: "Sales",
        designation_id: 21,
        designation_name: "Customer Service Associate",
        work_shift_id: 13,
        shift_name: "10-10",
        in_time: "10:00:00",
        out_time: "22:00:00",
        approved_headcount: 2,
        monthly_rate: 14500,
      },
      {
        staff_budget_id: 2,
        outlet_id: 3,
        outlet_name: "ECR",
        department_id: 1,
        department_name: "Sales",
        designation_id: 99,
        designation_name: "Supervisor",
        work_shift_id: 11,
        shift_name: "9-6",
        in_time: "09:00:00",
        out_time: "18:00:00",
        approved_headcount: 3,
        monthly_rate: null,
      },
    ];
    const data = await buildUsecase(fakeRepo({ rows })).getBudget({});

    assert.deepEqual(data.checkpoints.map((c) => c.key), ["opening", "peak", "closing"]);
    assert.equal(data.locations[0].total_headcount, 5);
    // The priced part only, and flagged as partial - an unpriced Supervisor
    // sits in the same location.
    assert.equal(data.locations[0].priced_monthly_budget, 29000);
    assert.equal(data.locations[0].priced_headcount, 2);
    assert.equal(data.locations[0].unpriced_headcount, 3);
    assert.equal(data.locations[0].fully_priced, false);
    assert.deepEqual(data.locations[0].departments[0].designations[0].coverage, {
      opening: 0,
      peak: 2,
      closing: 2,
    });
  });
});
