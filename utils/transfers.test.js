/**
 * Transfers - the queries, the per-article view, store scope, and the routes.
 *
 *   node --test utils/transfers.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const T = require("./transfers");
const usecaseFactory = require("../usecase/transfers");
const routesFactory = require("../routes/transfers");

const BRANCHES = [
  { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "wh" },
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "kathir" },
  { outlet_id: 7, outlet_name: "ECR", retailpilot_id: "ecr" },
];

const TRANSFERS = [
  { slug: "tA", job_type: "MIXED", origin_store: "wh", destination_store: "kathir", status: "IN_TRANSIT", dispatched_at: "2026-11-15T04:56:55Z", box_count: 3, total_landing_cost: "1500.50", stage_ids: ["INV-a", "ADA-b", "sta1"] },
  { slug: "tB", job_type: "GRN", origin_store: "wh", destination_store: "ecr", status: "PARTIALLY_RECEIVED", dispatched_at: "2026-11-15T04:16:00Z", stage_ids: "{INV-x,INV-y}" },
];
const LINES = [
  { slug: "l1", article_id: "1001", batch_id: "b1", box_id: "BX1", qty: 10, returned_qty: 0, status: "RECEIVED", landing_cost: 5, mrp: 8 },
  { slug: "l2", article_id: "1001", batch_id: "b2", box_id: "BX2", qty: 6, returned_qty: 2, status: "RECEIVED", landing_cost: 5, mrp: 8 },
  { slug: "l3", article_id: "1002", batch_id: "b3", box_id: "BX2", qty: 4, returned_qty: 0, status: "IN_TRANSIT", landing_cost: 10, mrp: 12 },
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
    if (/masterhub\.articles/.test(q)) return [{ id: "1001", article_name: "Aachi Chilli Powder 100g", external_id: "52011" }];
    if (/stock_transfer_lines/.test(q) && /GROUP BY/.test(q)) return [{ transfer_slug: "tA", short_lines: 1, returned_qty: 2, returned_value: 10, returned_at: "2026-11-15T07:00:00Z" }];
    if (/stock_transfer_lines/.test(q)) return LINES;
    if (/t\.slug = 'tA'/.test(q)) return TRANSFERS.slice(0, 1);
    if (/t\.slug = 'tB'/.test(q)) return TRANSFERS.slice(1);
    return TRANSFERS;
  });

describe("queries", () => {
  it("open transfers by default; a date range takes every one dispatched in it", () => {
    assert.match(T.buildTransfersQuery(null), /t\.status IN \('IN_TRANSIT', 'PARTIALLY_RECEIVED'\)/);
    const q = T.buildTransfersQuery({ from: "2026-11-01", to: "2026-11-15" });
    assert.match(q, /::date\) >= DATE '2026-11-01'/);
    assert.match(q, /::date\) <= DATE '2026-11-15'/);
    assert.doesNotMatch(q, /GROUP BY/);
  });

  it("only real days and plain ids are put into a query", () => {
    assert.equal(T.validRange("", ""), null);
    assert.ok(T.validRange("2026-11-15", "2026-11-01").error);
    assert.ok(T.validRange("2026-10-01", "2026-11-15").error, "more than 31 days");
    assert.throws(() => T.buildTransferQuery("x' OR '1'='1"));
    assert.equal(T.buildShortfallsQuery([]), null);
    assert.match(T.buildShortfallsQuery(["tA", "tA", "bad id!"]), /IN \('tA'\)/);
    assert.match(T.buildArticleNamesQuery(["1001", "1002"]), /CAST\(a\.slug AS TEXT\) IN \('1001', '1002'\)/);
  });
});

describe("articles", () => {
  it("one row per article across its boxes and batches; short ones first", () => {
    const articles = T.articlesFromLines(LINES, [{ id: "1001", article_name: "Aachi Chilli Powder 100g", external_id: "52011" }]);
    assert.deepEqual(
      articles.map((a) => [a.article_id, a.name, a.sent, a.received, a.short, a.in_transit, a.value, a.boxes.length]),
      [
        ["1001", "Aachi Chilli Powder 100g", 16, 14, 2, 0, 80, 2],
        ["1002", null, 4, 0, 0, 4, 40, 1],
      ]
    );
  });
});

describe("usecase", () => {
  it("lists open transfers with their shortfalls, narrowed to the caller's stores", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const all = await uc.list({});
    assert.equal(all.code, 200);
    assert.equal(all.data.open_only, true);
    assert.deepEqual(all.data.transfers.map((t) => [t.slug, t.store, t.status, t.short && t.short.returned_qty]), [
      ["tA", "outlet:3", "IN_TRANSIT", 2],
      ["tB", "outlet:7", "PARTIALLY_RECEIVED", null],
    ]);
    assert.deepEqual(all.data.transfers[0].documents_mix, { invoices: 1, adhoc: 1, sta: 1 });
    const own = await uc.list({ store_ids: [7] });
    assert.deepEqual(own.data.transfers.map((t) => t.slug), ["tB"]);
    assert.equal((await uc.list({ from_date: "2026-11-15", to_date: "2026-11-01" })).code, 422);
  });

  it("one transfer comes with its articles; another store's reads as not found", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const r = await uc.get({ slug: "tA", store_ids: null });
    assert.equal(r.code, 200);
    assert.deepEqual([r.data.store_name, r.data.origin_name, r.data.articles.length], ["Kathirkamam", "Warehouse", 2]);
    assert.deepEqual(r.data.short, { short_lines: 1, returned_qty: 2 });
    assert.equal((await uc.get({ slug: "tA", store_ids: [7] })).code, 404);
    assert.equal((await uc.get({ slug: "bad id!" })).code, 422);
  });

  it("RetailPilot refusing the list is a 502 with its reason", async () => {
    const broken = fakeSpectra(() => {
      throw new Error("SPECTRA error: whitelist_violation");
    });
    const r = await usecaseFactory(broken, async () => BRANCHES).list({});
    assert.equal(r.code, 502);
    assert.match(r.msg, /whitelist_violation/);
  });
});

describe("routes", () => {
  const serve = (dashboards) => {
    const app = express();
    app.use("/transfers", routesFactory(usecaseFactory(runway(), async () => BRANCHES), dashboards).getRouter());
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
    const server = await serve({
      requireDashboardAccess: (key) => (req, res, next) => {
        seen.push(key);
        req.dashboardScope = { kind: "OWN_STORE", store_ids: [3] };
        req.dashboardStoreIds = [3];
        next();
      },
      storeIdsFor: (req) => req.dashboardStoreIds,
    });
    try {
      const list = await get(server, "/transfers");
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.data.transfers.map((t) => t.slug), ["tA"]);
      assert.equal(list.body.dashboard_scope.kind, "OWN_STORE");
      assert.equal((await get(server, "/transfers/tA")).status, 200);
      assert.equal((await get(server, "/transfers/tB")).status, 404);
      assert.ok(seen.every((k) => k === "view_sales_dashboard"));
    } finally {
      server.close();
    }
  });
});
