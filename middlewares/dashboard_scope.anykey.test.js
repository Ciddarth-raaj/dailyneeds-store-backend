/**
 * The dashboard access check with a LIST of feature keys: the caller needs
 * ANY one of them (the Invoice pipeline opens on the Business Dashboard's key
 * or its own), and the store scope is decided exactly as with one key.
 *
 *   node --test middlewares/dashboard_scope.anykey.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildDashboardScope = require("./dashboard_scope");

const permissionsHolding = (keys) => ({
  ADMIN_USER_TYPE: 2,
  has: async (req, ...asked) => asked.some((k) => keys.includes(k)),
});
const repo = {
  getEmployeeStore: async (id) => ({ employee_id: id, store_id: 2, employee_status: 1, outlet_name: "Warehouse" }),
};
const req = { decoded: { employee_id: 7, user_type: 1, designation_id: 3 } };
const PAIR = ["view_sales_dashboard", "view_invoice_pipeline"];

describe("dashboard access with a list of keys", () => {
  it("holding only the second key is enough, with its own store scope", async () => {
    const d = buildDashboardScope(permissionsHolding(["view_invoice_pipeline", "dashboard_scope_own_store"]), repo);
    const scope = await d.resolveDashboardScope(req, PAIR);
    assert.equal(scope.kind, "OWN_STORE");
    assert.deepEqual(scope.store_ids, [2]);
  });

  it("holding neither key is refused before any store is looked at", async () => {
    let looked = false;
    const d = buildDashboardScope(permissionsHolding(["dashboard_scope_all_stores"]), {
      getEmployeeStore: async () => {
        looked = true;
        return null;
      },
    });
    const scope = await d.resolveDashboardScope(req, PAIR);
    assert.equal(scope.kind, "NONE");
    assert.equal(scope.reason, "NO_DASHBOARD_PERMISSION");
    assert.equal(looked, false);
  });

  it("the key but no store scope is still refused; one key as before still works", async () => {
    const noScope = buildDashboardScope(permissionsHolding(["view_invoice_pipeline"]), repo);
    assert.equal((await noScope.resolveDashboardScope(req, PAIR)).kind, "NONE");
    const single = buildDashboardScope(permissionsHolding(["view_sales_dashboard", "dashboard_scope_all_stores"]), repo);
    assert.equal((await single.resolveDashboardScope(req, "view_sales_dashboard")).kind, "ALL_STORES");
    assert.equal((await single.resolveDashboardScope(req, [])).kind, "NONE", "an empty list opens nothing");
  });
});
