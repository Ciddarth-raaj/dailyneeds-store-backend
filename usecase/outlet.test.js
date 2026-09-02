const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildOutletUsecase = require("./outlet");

const ROW = {
  outlet_id: 3,
  outlet_name: "Anna Nagar",
  outlet_code: "AN",
  allowed_ips: "203.0.113.10, 203.0.113.11",
  ip_restriction_enabled: 1,
  employee_count: "4",
};

const makeRepos = ({ affectedRows = 1, row = ROW } = {}) => {
  const updates = [];
  return {
    updates,
    outletRepo: {
      async get() {
        return [row];
      },
      async getOutletByOutletId() {
        return [row];
      },
      async getIpRestrictions() {
        return [row];
      },
      async getIpRestriction(id) {
        return row && Number(id) === row.outlet_id ? row : null;
      },
      async updateIpRestriction(outletId, allowedIps, enabled) {
        updates.push({ outletId, allowedIps, enabled });
        return { affectedRows };
      },
    },
    budgetRepo: {
      async getBudgetByStoreId() {
        return [];
      },
    },
  };
};

describe("updateIpRestriction", () => {
  it("stores a normalized list with the switch on", async () => {
    const { outletRepo, budgetRepo, updates } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    const result = await usecase.updateIpRestriction(3, " 203.0.113.10 ,\n203.0.113.0/24 ", true);
    assert.equal(result.code, 200);
    assert.equal(result.ip_restriction_enabled, true);
    assert.deepEqual(updates, [
      { outletId: 3, allowedIps: "203.0.113.10, 203.0.113.0/24", enabled: true },
    ]);
  });

  it("stores no list with the switch off", async () => {
    const { outletRepo, budgetRepo, updates } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    await usecase.updateIpRestriction(3, "", false);
    assert.deepEqual(updates, [{ outletId: 3, allowedIps: null, enabled: false }]);
  });

  it("keeps the list on file while the switch is off", async () => {
    const { outletRepo, budgetRepo, updates } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    await usecase.updateIpRestriction(3, "203.0.113.10", 0);
    assert.deepEqual(updates, [{ outletId: 3, allowedIps: "203.0.113.10", enabled: false }]);
  });

  it("refuses to switch on with nothing to fall back on", async () => {
    const { outletRepo, budgetRepo, updates } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    await assert.rejects(
      () => usecase.updateIpRestriction(3, "", true),
      (err) => err.name === "ValidationError" && /at least one allowed IP/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });

  it("refuses a loopback entry", async () => {
    const { outletRepo, budgetRepo, updates } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    await assert.rejects(
      () => usecase.updateIpRestriction(3, "127.0.0.1", true),
      (err) => err.name === "ValidationError" && /talking to itself/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });

  it("reports an unknown branch rather than pretending to save", async () => {
    const { outletRepo, budgetRepo } = makeRepos({ affectedRows: 0 });
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    await assert.rejects(
      () => usecase.updateIpRestriction(99, "203.0.113.10", true),
      (err) => err.name === "NotFoundError"
    );
  });
});

describe("token-less outlet reads", () => {
  it("strips the IP fields from the list", async () => {
    const { outletRepo, budgetRepo } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    const [row] = await usecase.get();
    assert.equal(row.outlet_name, "Anna Nagar");
    assert.equal("allowed_ips" in row, false);
    assert.equal("ip_restriction_enabled" in row, false);
  });

  it("strips the IP fields from the single-outlet read", async () => {
    const { outletRepo, budgetRepo } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    const [row] = await usecase.getOutletByOutletId(3);
    assert.equal("allowed_ips" in row, false);
    assert.equal("ip_restriction_enabled" in row, false);
    assert.deepEqual(row.budget, []);
  });
});

describe("IP restriction reads", () => {
  it("parses the list and reads the flag as a boolean", async () => {
    const { outletRepo, budgetRepo } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    const [row] = await usecase.getIpRestrictions();
    assert.deepEqual(row.allowed_ips, ["203.0.113.10", "203.0.113.11"]);
    assert.equal(row.ip_restriction_enabled, true);
    assert.equal(row.employee_count, 4);
  });

  it("returns null for a branch that does not exist", async () => {
    const { outletRepo, budgetRepo } = makeRepos();
    const usecase = buildOutletUsecase(outletRepo, budgetRepo);

    assert.equal(await usecase.getIpRestriction(99), null);
  });
});
