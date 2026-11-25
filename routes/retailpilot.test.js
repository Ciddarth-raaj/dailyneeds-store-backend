/**
 * RetailPilot Sync page status: each card's last SCHEDULED run and next
 * scheduled time, not just whatever ran last (often a manual "Sync now").
 *
 *   node --test routes/retailpilot.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const retailpilotRoutes = require("./retailpilot");

const { nextRun } = retailpilotRoutes;

describe("nextRun", () => {
  const at = new Date("2026-11-25T22:50:00Z"); // 04:20 IST, 26 Nov
  it("the soonest run of the expressions, in IST", () => {
    assert.equal(nextRun(["0 9,14,17 * * *"], at), "2026-11-26T03:30:00.000Z", "9:00 IST");
    assert.equal(nextRun(["0 6 * * *", "*/15 * * * *"], at), "2026-11-25T23:00:00.000Z", "04:30 IST");
  });
  it("nothing scheduled: null", () => assert.equal(nextRun([], at), null));
});

describe("GET /status", () => {
  const rows = [
    // Newest first, as the repository returns them.
    { log_type: "retailpilot_purchase_sync", source: "manual", status: "success", created_at: "2026-11-25T22:19:00Z" },
    { log_type: "retailpilot_purchase_sync", source: "cron", status: "success", created_at: "2026-11-25T11:30:00Z" },
    { log_type: "product_sync", source: "manual", status: "success", created_at: "2026-11-20T03:43:00Z" },
    { log_type: "retailpilot_supplier_sync", source: "cron", status: "success", created_at: "2026-11-26T04:30:00Z" },
    { log_type: "retailpilot_stock_sync", source: "cron", status: "success", created_at: "2026-11-25T00:32:00Z" },
  ];
  const repo = {
    getLogs: async ({ log_type, source, limit }) =>
      rows.filter((r) => r.log_type === log_type && (!source || r.source === source)).slice(0, limit),
  };
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(
      "/retailpilot",
      retailpilotRoutes({
        apiSyncLogRepo: repo,
        config: { grnSyncEnabled: true, stockSyncEnabled: true, purchaseSyncEnabled: true, debitNoteSyncEnabled: true, articleStoreMasterEnabled: false, supplierSyncEnabled: true },
        isRunning: {},
      }).getRouter()
    );
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const status = () =>
    new Promise((resolve, reject) =>
      http.get(`${base}/retailpilot/status`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body).data));
      }).on("error", reject)
    );

  it("last_scheduled is the cron's run even when a manual run is newer", async () => {
    const p = (await status()).find((s) => s.key === "purchases");
    assert.equal(p.last_run.source, "manual");
    assert.equal(p.last_scheduled.source, "cron");
    assert.equal(p.last_scheduled.at, "2026-11-25T11:30:00Z");
    assert.ok(p.next_run);
  });

  it("products: the scheduled run is the 6:00 Stock & Prices run", async () => {
    const p = (await status()).find((s) => s.key === "products");
    assert.equal(p.last_run.source, "manual");
    assert.equal(p.last_scheduled.at, "2026-11-25T00:32:00Z");
  });

  it("distributors: a card with the 10:00 / 12:30 / 4:00 schedule", async () => {
    const d = (await status()).find((s) => s.key === "suppliers");
    assert.equal(d.label, "Distributors");
    assert.equal(d.schedule, "Daily 10:00 AM, 12:30 PM, 4:00 PM");
    assert.equal(d.last_scheduled.at, "2026-11-26T04:30:00Z");
    assert.equal(d.permission, "add_product_distributor");
  });

  it("a sync that is switched off has no next run", async () => {
    const a = (await status()).find((s) => s.key === "article_store_master");
    assert.equal(a.next_run, null);
    assert.equal(a.last_scheduled, null);
  });
});
