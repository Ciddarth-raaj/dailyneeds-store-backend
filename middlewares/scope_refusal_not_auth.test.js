/**
 * An authorisation refusal must never look like a dead session.
 *
 *   node --test middlewares/scope_refusal_not_auth.test.js
 *
 * The web app (`util/handle403.js`) sends the browser to /login only for the
 * authentication refusal `middlewares/auth.js` sends: `msg: "Access Denied"`,
 * or a 403 with no `msg`. Every other 403 keeps the session. If a scope or
 * admin-only refusal ever reused "Access Denied", or dropped its `msg`, a
 * signed-in manager would be logged out by a screen they merely cannot see -
 * which is how managers were bounced off /dashboard after signing in.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SCOPE_MESSAGE } = require("../utils/dashboard_scope");
const { BRANCH_SCOPE_MESSAGE } = require("../utils/employee_branch_scope");
const { requireAdmin } = require("./admin_only");

const AUTH_DENIED_MSG = "Access Denied";

const assertNotAuth = (label, msg) => {
  assert.equal(typeof msg, "string", `${label} has a msg`);
  assert.ok(msg.length > 0, `${label} has a non-empty msg`);
  assert.notEqual(msg, AUTH_DENIED_MSG, `${label} must not read as a dead session`);
};

describe("scope refusals carry their own message, never the auth one", () => {
  it("every dashboard-scope message", () => {
    for (const [reason, msg] of Object.entries(SCOPE_MESSAGE)) {
      if (reason === "UNAUTHENTICATED") continue; // sent as a real 401
      assertNotAuth(`SCOPE_MESSAGE.${reason}`, msg);
    }
  });

  it("every employee branch-scope message", () => {
    for (const [reason, msg] of Object.entries(BRANCH_SCOPE_MESSAGE)) {
      if (reason === "UNAUTHENTICATED") continue; // sent as a real 401
      assertNotAuth(`BRANCH_SCOPE_MESSAGE.${reason}`, msg);
    }
  });

  it("the administrator-only refusal for a manager", () => {
    let body = null;
    const res = { status() { return this; }, json(b) { body = b; return this; } };
    requireAdmin({ decoded: { user_type: 1, designation_id: 7 } }, res, () => {});
    assert.equal(body.code, 403);
    assertNotAuth("requireAdmin", body.msg);
  });
});
