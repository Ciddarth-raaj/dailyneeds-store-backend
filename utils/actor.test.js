const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const actor = require("./actor");

const employeeReq = { auth: { userId: 7, employeeId: 1003, isSystemAccount: false } };
const systemReq = { auth: { userId: 99, employeeId: null, isSystemAccount: true } };

describe("caller identity helpers (A3/C3)", () => {
  it("actorUserId returns the account key for both kinds of account", () => {
    assert.equal(actor.actorUserId(employeeReq), 7);
    assert.equal(actor.actorUserId(systemReq), 99);
  });

  it("actorUserId throws 401 without a session", () => {
    assert.throws(() => actor.actorUserId({}), (e) => e.status === 401);
  });

  it("requireEmployee returns the employee code for a real employee", () => {
    assert.equal(actor.requireEmployee(employeeReq, "x"), 1003);
  });

  it("44. requireEmployee refuses a system account with a typed 403, never NULL", () => {
    assert.throws(
      () => actor.requireEmployee(systemReq, "Raising a ticket"),
      (e) => e.name === "SystemAccountError" && e.status === 403 && e.code === "EMPLOYEE_REQUIRED"
    );
  });

  it("requireEmployee refuses an employee-less non-system session too", () => {
    assert.throws(() => actor.requireEmployee({ auth: { userId: 5, employeeId: null, isSystemAccount: false } }));
  });

  it("employeeIdOrNull is null for a system account and the code otherwise", () => {
    assert.equal(actor.employeeIdOrNull(systemReq), null);
    assert.equal(actor.employeeIdOrNull(employeeReq), 1003);
  });

  it("rejectSystemAccounts middleware stops a system account", () => {
    let status = null;
    let body = null;
    const res = { status: (s) => ((status = s), res), json: (b) => ((body = b), res) };
    let nexted = false;
    actor.rejectSystemAccounts("op")(systemReq, res, () => (nexted = true));
    assert.equal(nexted, false);
    assert.equal(status, 403);
    assert.equal(body.error, "EMPLOYEE_REQUIRED");
    actor.rejectSystemAccounts("op")(employeeReq, res, () => (nexted = true));
    assert.equal(nexted, true);
  });
});
