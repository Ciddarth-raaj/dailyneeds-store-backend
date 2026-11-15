/**
 * Warehouse Flow - stage 1 (gate pass): the queries, one row per pass, the
 * store scope on the list and on one pass, and the routes' guard.
 *
 *   node --test utils/warehouse_flow.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const W = require("./warehouse_flow");
const { storeResolver } = require("./business_dashboard");
const usecaseFactory = require("../usecase/warehouse_flow");
const routesFactory = require("../routes/warehouse_flow");

const BRANCHES = [
  { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "wh" },
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "kathir" },
];

const PASS_ROWS = [
  { slug: "GP-1", status: "OPEN", store_id: "wh", supplier_id: 42, vehicle_number: "PY01AB1234", entry_time: "2026-11-14T06:00:00Z", inspection_slug: "IN-1", inspection_state: "IN_PROGRESS", invoice_amount: "1500.5" },
  { slug: "GP-1", status: "OPEN", store_id: "wh", supplier_id: 42, vehicle_number: "PY01AB1234", entry_time: "2026-11-14T06:00:00Z", inspection_slug: "IN-2", inspection_state: "DONE" },
  { slug: "GP-2", status: "OPEN", store_id: "kathir", supplier_id: "9", entry_time: "2026-11-15T04:30:00Z", inspection_slug: null },
];

const fakeSpectra = (handler) => ({
  isConfigured: () => true,
  queries: [],
  async queryAll(q) {
    this.queries.push(q);
    return handler(q);
  },
});

const runway = () =>
  fakeSpectra((q) => {
    if (/masterhub\.vendors/.test(q)) return [{ id: "42", name: "Acme Foods" }];
    if (/grn_inspection_details/.test(q)) return [{ grn_inspection_id: "IN-1", lines: 12, invoice_qty: 100, inspected_qty: 96, free_qty: 4, rejected_qty: 2 }];
    if (/g\.slug = 'GP-1'/.test(q)) return PASS_ROWS.slice(0, 2);
    if (/g\.slug = 'GP-2'/.test(q)) return PASS_ROWS.slice(2);
    if (/g\.status = 'OPEN'/.test(q)) return PASS_ROWS;
    return [];
  });

describe("queries", () => {
  it("open passes only, oldest first, with their inspections", () => {
    const q = W.buildOpenGatePassesQuery();
    assert.match(q, /FROM public\.gate_passes g/);
    assert.match(q, /WHERE g\.status = 'OPEN'/);
    assert.match(q, /ON i\.gatepass_slug = g\.slug/);
    assert.match(q, /ORDER BY g\.entry_time/);
  });

  it("only a plain slug is ever put in a query", () => {
    assert.match(W.buildGatePassQuery("GP-251229-ABCDEFG-001"), /g\.slug = 'GP-251229-ABCDEFG-001'/);
    assert.throws(() => W.buildGatePassQuery("GP-1' OR '1'='1"));
    assert.equal(W.buildInspectionTotalsQuery([]), null);
    assert.equal(W.buildInspectionTotalsQuery(["x'; DROP TABLE y; --"]), null);
    assert.match(W.buildInspectionTotalsQuery(["IN-1", "IN-1", "IN-2"]), /IN \('IN-1', 'IN-2'\)/);
  });
});

describe("mapping", () => {
  it("one row per pass, supplier named, inspections collected, age to now or to exit", () => {
    const { resolve } = storeResolver(BRANCHES);
    const now = Date.parse("2026-11-15T06:00:00Z");
    const rows = W.mapGatePassRows(
      [...PASS_ROWS, { slug: "GP-3", status: "closed", store_id: "wh", entry_time: "2026-11-15T01:00:00Z", exit_time: "2026-11-15T03:30:00Z" }],
      [{ id: "42", name: "Acme Foods" }],
      resolve,
      now
    );
    assert.deepEqual(rows.map((r) => [r.slug, r.store, r.open_hours, r.inspections.length]), [
      ["GP-1", "outlet:2", 24, 2],
      ["GP-2", "outlet:3", 1.5, 0],
      ["GP-3", "outlet:2", 2.5, 0],
    ]);
    assert.equal(rows[0].supplier_name, "Acme Foods");
    assert.equal(rows[0].inspections[0].invoice_amount, 1500.5);
    assert.equal(rows[2].status, "CLOSED");
  });
});

describe("usecase", () => {
  it("the flow lists stage 1 in scope; the other stages are not read", async () => {
    const s = runway();
    const uc = usecaseFactory(s, async () => BRANCHES);
    const all = await uc.getFlow({ store_ids: null });
    assert.deepEqual(all.data.stages.map((x) => [x.key, x.built]), [
      ["gate_pass", true],
      ["inspection", false],
      ["grn", false],
      ["allocation", false],
      ["ready_to_dispatch", false],
    ]);
    assert.deepEqual(all.data.stages[0].rows.map((r) => r.slug), ["GP-1", "GP-2"]);
    const own = await uc.getFlow({ store_ids: [3] });
    assert.deepEqual(own.data.stages[0].rows.map((r) => r.slug), ["GP-2"]);
    assert.deepEqual(own.data.stores.map((x) => x.key), ["outlet:3"]);
  });

  it("one pass comes with its inspection totals; another branch's pass is not found", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const r = await uc.getGatePass({ slug: "GP-1", store_ids: null });
    assert.equal(r.code, 200);
    assert.equal(r.data.store_name, "Warehouse");
    assert.deepEqual(r.data.inspections[0].totals, { lines: 12, invoice_qty: 100, inspected_qty: 96, free_qty: 4, rejected_qty: 2 });
    assert.equal(r.data.inspections[1].totals, null);
    assert.equal((await uc.getGatePass({ slug: "GP-1", store_ids: [3] })).code, 404);
    assert.equal((await uc.getGatePass({ slug: "bad slug!" })).code, 422);
  });

  it("RetailPilot refusing the list is reported, not thrown", async () => {
    const broken = fakeSpectra(() => {
      throw new Error("SPECTRA error: whitelist_violation");
    });
    const r = await usecaseFactory(broken, async () => BRANCHES).getFlow({});
    assert.equal(r.data.stages[0].ok, false);
    assert.match(r.data.stages[0].error, /whitelist_violation/);
  });
});

describe("routes", () => {
  const serve = (dashboards) => {
    const app = express();
    app.use("/warehouse-flow", routesFactory(usecaseFactory(runway(), async () => BRANCHES), dashboards).getRouter());
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  };
  const get = (server, path) =>
    new Promise((resolve, reject) => {
      http
        .get({ port: server.address().port, path }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        })
        .on("error", reject);
    });

  it("are behind the Business Dashboard key and scope", async () => {
    const seen = [];
    const dashboards = {
      requireDashboardAccess: (key) => (req, res, next) => {
        seen.push(key);
        req.dashboardScope = { kind: "OWN_STORE", store_ids: [3] };
        req.dashboardStoreIds = [3];
        next();
      },
      storeIdsFor: (req) => req.dashboardStoreIds,
    };
    const server = await serve(dashboards);
    try {
      const flow = await get(server, "/warehouse-flow/flow");
      assert.equal(flow.status, 200);
      assert.deepEqual(flow.body.data.stages[0].rows.map((r) => r.slug), ["GP-2"]);
      assert.equal(flow.body.dashboard_scope.kind, "OWN_STORE");
      assert.equal((await get(server, "/warehouse-flow/gate-pass/GP-1")).status, 404);
      assert.equal((await get(server, "/warehouse-flow/gate-pass/GP-2")).status, 200);
      assert.ok(seen.every((k) => k === "view_sales_dashboard"));
    } finally {
      server.close();
    }
  });

  it("refuse whoever the guard refuses", async () => {
    const server = await serve({
      requireDashboardAccess: () => (req, res) => res.status(403).json({ code: 403, msg: "no" }),
      storeIdsFor: () => [],
    });
    try {
      assert.equal((await get(server, "/warehouse-flow/flow")).status, 403);
    } finally {
      server.close();
    }
  });
});
