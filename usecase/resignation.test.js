/**
 * The legacy resignation delete may not reactivate an employee whose exit is
 * recorded in the employee lifecycle - that is a rejoin, and only Rejoin (with
 * the rehire assessment gate) may do it.
 *
 *   node --test usecase/resignation.test.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const buildUsecase = require("./resignation");

describe("legacy resignation delete vs the employee lifecycle", () => {
  let writes;
  let exits;
  let uc;
  beforeEach(() => {
    writes = [];
    exits = new Map();
    const employeeRepo = {
      getEmployeeIdByDelete: async (id) => Number(id),
      updateStatus: async (x) => writes.push(["employee", x]),
    };
    const userRepo = { updateStatus: async (x) => writes.push(["user", x]) };
    const resignationRepo = { deleteResignation: async (id) => (writes.push(["resignation", id]), { code: 200 }) };
    uc = buildUsecase(resignationRepo, employeeRepo, userRepo);
    uc.exitGuard = { lifecycleExitOf: async (id) => exits.get(id) || null };
  });

  for (const [label, exit] of [
    ["resignation date recorded (assessed NO)", { resignation_date: "2026-08-16", latest_period_state: "closed" }],
    ["resignation date recorded (assessed YES)", { resignation_date: "2026-08-16", latest_period_state: "closed" }],
    ["employment period closed", { resignation_date: null, latest_period_state: "closed" }],
  ]) {
    it(`refuses, and writes NOTHING, when the lifecycle has an exit: ${label}`, async () => {
      exits.set(2, exit);
      const res = await uc.deleteResignation("2");
      assert.equal(res.code, 409);
      assert.equal(res.error, "EXIT_RECORDED_USE_REJOIN");
      assert.match(res.msg, /use Rejoin/);
      assert.deepEqual(writes, [], "not reactivated, login not re-enabled, resignation kept");
    });
  }

  it("an employee with no lifecycle exit (open period, no resignation date) is handled exactly as before", async () => {
    exits.set(1, { resignation_date: null, latest_period_state: "open" });
    assert.equal(await uc.deleteResignation("1"), 200);
    assert.deepEqual(writes.map((w) => w[0]), ["employee", "user", "resignation"]);
  });

  it("without the guard wired (older wiring) the behaviour is unchanged", async () => {
    uc.exitGuard = undefined;
    assert.equal(await uc.deleteResignation("3"), 200);
  });
});
