/**
 * The administrator-only boundary.
 *
 *   node --test middlewares/admin_only.test.js
 *
 * What matters here is what it REFUSES. `attendance_required` is
 * administrators only by requirement - HR must not be able to change it, and
 * nor must a Store Manager - so no permission key may open it, including a
 * key an administrator could grant by accident.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { requireAdmin, isAdminRequest } = require("./admin_only");

const run = (req) => {
  let status = 200;
  let body = null;
  let nexted = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  requireAdmin(req, res, () => {
    nexted = true;
  });
  return { status, body, nexted };
};

describe("requireAdmin", () => {
  it("lets user_type 2 through", () => {
    const r = run({ decoded: { user_type: 2, designation_id: 9 } });
    assert.equal(r.nexted, true);
  });

  it("accepts the user_type MySQL hands back as a string", () => {
    assert.equal(isAdminRequest({ decoded: { user_type: "2" } }), true);
  });

  it("401s an unauthenticated request", () => {
    const r = run({});
    assert.equal(r.status, 401);
    assert.equal(r.nexted, false);
  });

  it("403s every non-administrator, whatever permissions they hold", () => {
    for (const userType of [0, 1, 3, null, undefined, "admin"]) {
      const r = run({
        decoded: { user_type: userType, designation_id: 1, permissions: ["employee_edit"] },
      });
      assert.equal(r.nexted, false, `user_type ${userType} must not pass`);
      assert.equal(r.status, 403);
      assert.match(r.body.msg, /administrator/i);
    }
  });
});
