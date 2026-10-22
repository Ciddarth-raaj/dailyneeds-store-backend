/**
 * Suppliers from RetailPilot: the supplier rows, each article's supplier, the
 * guard against a wiping pull, the manual-first rule, and the endpoint.
 *
 *   node --test utils/retailpilot_suppliers.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const { supplierRows, supplierByArticle, guard, cidOf, RP_CODE_BASE, QUERIES } = require("./retailpilot_suppliers");
const syncFactory = require("../usecase/retailpilot_supplier_sync");
const buildPermissions = require("../middlewares/permissions");

describe("supplier rows", () => {
  it("RetailPilot vendors as DNDS suppliers: RP-prefixed CID, a code no old one can have, trade name first", () => {
    const { rows, skipped } = supplierRows([
      { id: "10001", name: "akshaya agencies pvt ltd", trade_name: "akshaya agencies (zyro)", is_active: true },
      { id: "10002", name: "metro home need", trade_name: "", is_active: false },
      { id: "abc", name: "bad id" },
    ]);
    assert.deepEqual(rows, [
      { cid: "RP10001", mdm_dist_code: RP_CODE_BASE + 10001, mdm_dist_name: "akshaya agencies (zyro)", mdm_short_name: "akshaya agencies pvt ltd", mdm_tag: "a" },
      { cid: "RP10002", mdm_dist_code: RP_CODE_BASE + 10002, mdm_dist_name: "metro home need", mdm_short_name: "metro home need", mdm_tag: "i" },
    ]);
    assert.deepEqual(skipped, [{ id: "abc", reason: "vendor id is not a number" }]);
    assert.ok(rows.every((r) => r.mdm_dist_code < 2147483647), "fits the INT column");
  });
});

describe("each article's supplier", () => {
  const stores = [{ slug: "wh", type: "warehouse" }, { slug: "dn1", type: "store" }];
  const known = new Set(["RP10001", "RP10002", "RP10003"]);

  it("the all-stores rule; else the warehouse's; else any store's - the lowest vendor id", () => {
    const m = supplierByArticle(
      [
        { article_id: 1, store_id: null, supplier_id: "10002" },
        { article_id: 1, store_id: "dn1", supplier_id: "10001" },
        { article_id: 2, store_id: "dn1", supplier_id: "10001" },
        { article_id: 2, store_id: "wh", supplier_id: "10003" },
        { article_id: 3, store_id: "dn1", supplier_id: "10003" },
        { article_id: 3, store_id: "dn1", supplier_id: "10002" },
        { article_id: 4, store_id: null, supplier_id: "99999" },
      ],
      stores,
      known
    );
    assert.deepEqual(Object.fromEntries(m), { 1: "RP10002", 2: "RP10003", 3: "RP10002" });
    assert.equal(m.has("4"), false, "a supplier RetailPilot does not list is not used");
  });
});

describe("the guard", () => {
  it("never wipes the list on an empty or shrunken pull", () => {
    assert.match(guard(0, 0), /no suppliers/);
    assert.match(guard(40, 100), /fewer than half/);
    assert.equal(guard(60, 100), null);
    assert.equal(guard(500, 0), null, "the first switch");
  });

  it("the queries are masterhub's, ordered for stable paging", () => {
    assert.match(QUERIES.vendors, /FROM public\.vendors v\s+ORDER BY v\.id/);
    assert.match(QUERIES.articleSuppliers, /FROM derived\.article_store_suppliers/);
    assert.equal(cidOf("10001"), "RP10001");
  });
});

const fakeMasterhub = () => ({
  isConfigured: () => true,
  queryAll: async (q) =>
    q === QUERIES.vendors ? [{ id: "10001", name: "a", trade_name: "A", is_active: true }] : q === QUERIES.stores ? [] : [],
});

describe("the sync", () => {
  it("the schedule never makes the first switch; a person does", async () => {
    let applied = 0;
    const repo = { countRetailPilotSuppliers: async () => 0, apply: async () => { applied += 1; return { code: 200 }; } };
    const s = syncFactory(fakeMasterhub(), repo);
    const r = await s.run({ scheduled: true });
    assert.equal(r.code, 200);
    assert.match(r.skipped, /by hand/);
    assert.equal(applied, 0);
    assert.equal((await s.run({ dryRun: true })).code, 200);
    assert.equal(applied, 1, "by hand: applied");
  });

  it("after the first switch, the schedule keeps it current", async () => {
    let applied = 0;
    const repo = { countRetailPilotSuppliers: async () => 500, apply: async () => { applied += 1; return { code: 200 }; } };
    await syncFactory(fakeMasterhub(), repo).run({ scheduled: true });
    assert.equal(applied, 1);
  });

  it("a RetailPilot failure is a reason, not a crash, and nothing is applied", async () => {
    let applied = 0;
    const repo = { countRetailPilotSuppliers: async () => 1, apply: async () => { applied += 1; } };
    const failing = { isConfigured: () => true, queryAll: async () => { throw new Error("SPECTRA error: whitelist_violation"); } };
    const r = await syncFactory(failing, repo).run();
    assert.equal(r.code, 502);
    assert.equal(applied, 0);
  });
});

describe("POST /product-distributors/retailpilot-sync", () => {
  let server;
  let base;
  const calls = [];
  before(() => {
    const GRANTS = { 10: ["add_product_distributor"], 11: ["view_product_distributors"] };
    const permissions = buildPermissions({ getPermissionById: async (d) => (GRANTS[d] || []).map((k) => ({ permission_key: k })) });
    const sync = { run: async (o) => { calls.push(o); return { code: 200, dry_run: o.dryRun }; } };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const s = req.headers["x-test-session"];
      if (s) req.decoded = JSON.parse(s);
      next();
    });
    app.use("/product-distributors", require("../routes/product_distributors")({}, sync, permissions).getRouter());
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const post = (session, body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(`${base}/product-distributors/retailpilot-sync`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-test-session": JSON.stringify(session) } : {}) } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
      });
      req.on("error", reject);
      req.end(data);
    });

  it("only with add_product_distributor (or as admin); dry_run passed through", async () => {
    assert.equal((await post({ employee_id: 5, designation_id: 11, user_type: 1 }, { dry_run: true })).status, 403);
    assert.equal(calls.length, 0);
    const r = await post({ employee_id: 6, designation_id: 10, user_type: 1 }, { dry_run: true });
    assert.deepEqual(r.body, { code: 200, dry_run: true });
    await post({ employee_id: 1, user_type: 2 }, {});
    assert.deepEqual(calls, [{ dryRun: true }, { dryRun: false }]);
  });
});
