const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./password_policy");

const ctx = { username: "1003", employeeId: 1003, mobile: "9000000000", currentPassword: "old-one-here" };

describe("password policy (B3)", () => {
  it("accepts a reasonable password", () => {
    assert.deepEqual(policy.check("blue-kettle-42", ctx), { ok: true });
  });

  it("enforces the minimum length", () => {
    assert.equal(policy.check("short1", ctx).ok, false);
  });

  it("17. rejects the employee code, username and mobile", () => {
    assert.equal(policy.check("1003", ctx).ok, false);
    assert.equal(policy.check("9000000000", ctx).ok, false);
    assert.equal(policy.check("90000-00000", ctx).ok, false);
  });

  it("17. rejects the historical provisioning defaults", () => {
    assert.equal(policy.check("1003@123", ctx).ok, false);
    assert.equal(policy.check("password", ctx).ok, false);
    assert.equal(policy.check("PASSWORD", ctx).ok, false);
  });

  it("rejects common passwords and repeated characters", () => {
    assert.equal(policy.check("password123", ctx).ok, false);
    assert.equal(policy.check("aaaaaaaaaa", ctx).ok, false);
  });

  it("rejects the current password as the new one", () => {
    assert.equal(policy.check("old-one-here", ctx).ok, false);
  });

  it("honours a higher minimum for break-glass", () => {
    assert.equal(policy.check("blue-kettle-42", { minLength: 20 }).ok, false);
    assert.equal(policy.check("blue-kettle-42-orange-lamp", { minLength: 20 }).ok, true);
  });
});
