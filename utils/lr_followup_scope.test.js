/**
 * LR Follow-up access scope - its own rule, not the dashboard scope.
 *
 *   node --test utils/lr_followup_scope.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { decideLrScope, createLrScope, LR_ALL_STORES_KEY } = require("./lr_followup_scope");

const active = (store_id = 1) => ({ employee_id: 501, store_id, employee_status: 1 });

describe("the rule", () => {
  it("administrators and lr_followup_all_stores holders see every branch", () => {
    assert.equal(decideLrScope({ isAdmin: true }).store_ids, null);
    assert.equal(decideLrScope({ isAdmin: false, hasAllStores: true, employee: active() }).store_ids, null);
    // ...even with no branch of their own: the follow-up desk is company-wide.
    assert.equal(decideLrScope({ isAdmin: false, hasAllStores: true, employee: active(null) }).store_ids, null);
  });

  it("everyone else sees their own branch, read from Employee Master", () => {
    assert.deepEqual(decideLrScope({ isAdmin: false, hasAllStores: false, employee: active(7) }).store_ids, [7]);
  });

  it("refuses rather than widening", () => {
    assert.equal(decideLrScope({ isAdmin: false, hasAllStores: false, employee: active(null) }).kind, "NONE");
    assert.equal(decideLrScope({ isAdmin: false, hasAllStores: true, employee: null }).kind, "NONE");
    assert.equal(
      decideLrScope({ isAdmin: false, hasAllStores: true, employee: { ...active(), employee_status: 0 } }).kind,
      "NONE"
    );
  });
});

describe("the resolver", () => {
  const build = (held, employee) => {
    const asked = [];
    const permissions = {
      ADMIN_USER_TYPE: 2,
      has: async (req, key) => {
        asked.push(key);
        return held.includes(key);
      },
    };
    const repo = { getEmployeeStore: async () => employee };
    return { scope: createLrScope(permissions, repo), asked };
  };
  const req = (user_type = 1) => ({ decoded: { employee_id: 501, user_type } });

  it("asks only for its own key - the dashboard scope keys play no part", async () => {
    const { scope, asked } = build(["dashboard_scope_own_store"], active(3));
    assert.deepEqual(await scope.storeIds(req()), [3]);
    assert.deepEqual(asked, [LR_ALL_STORES_KEY]);
  });

  it("a dashboard Own Store holder with the LR all-stores key sees every branch", async () => {
    const { scope } = build(["dashboard_scope_own_store", LR_ALL_STORES_KEY], active(3));
    assert.equal(await scope.storeIds(req()), null);
  });

  it("a dashboard All Stores key does NOT widen LR follow-ups", async () => {
    const { scope } = build(["dashboard_scope_all_stores"], active(3));
    assert.deepEqual(await scope.storeIds(req()), [3]);
  });

  it("an administrator needs no grant", async () => {
    const { scope } = build([], null);
    assert.equal(await scope.storeIds(req(2)), null);
  });

  it("no branch and no all-stores key is a ForbiddenError", async () => {
    const { scope } = build([], active(null));
    await assert.rejects(scope.storeIds(req()), (e) => e.name === "ForbiddenError" && e.reason === "NO_STORE_ASSIGNED");
  });
});
