/**
 * Sales Reconciliation - "Pull from RetailPilot": the query, its rows in the
 * Retail Pilot CSV's shape, the SPECTRA product (Mandapam), and the endpoint.
 *
 *   node --test utils/retailpilot_sales.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const { validDay, buildSalesQuery, mapSalesRows } = require("./retailpilot_sales");
const salesFactory = require("../usecase/retailpilot_sales");
const spectraFactory = require("../services/retailpilot_spectra");

describe("the day", () => {
  it("only a real YYYY-MM-DD day is accepted", () => {
    assert.equal(validDay("2026-10-16"), "2026-10-16");
    for (const bad of ["", "2026-02-30", "16-10-2026", "2026-10-16'; DROP TABLE bills; --", "2026-10-16 ", null]) {
      assert.equal(validDay(bad) === null || validDay(bad) === "2026-10-16", true, String(bad));
    }
    assert.equal(validDay("2026-10-16'; DROP TABLE bills; --"), null);
    assert.equal(validDay("2026-02-30"), null);
  });

  it("the query is for that one day, and refuses anything else", () => {
    const q = buildSalesQuery("2026-10-16");
    assert.equal((q.match(/DATE '2026-10-16'/g) || []).length, 2, "bills and loyalty both for the day");
    assert.match(q, /FILTER \(WHERE b\.sign = 1\)/);
    assert.match(q, /FILTER \(WHERE b\.sign = -1\)/);
    assert.match(q, /bp\.payment_type = 'loyalty'/);
    assert.match(q, /AS outletname/);
    assert.match(q, /FROM public\.bills b/, "the owner's tables, as the query runs on RetailPilot");
    assert.match(q, /FROM public\.bill_payments bp\s+JOIN public\.bills b ON b\.bill_no = bp\.bill_no/);
    assert.match(q, /LEFT JOIN peti\.stores st ON st\.slug = s\.store_slug/);
    assert.throws(() => buildSalesQuery("2026-10-16' OR '1'='1"), /YYYY-MM-DD/);
  });
});

describe("rows", () => {
  it("come back in the CSV's columns, amounts to paise, the day only", () => {
    const rows = mapSalesRows(
      [
        { date: "2026-10-16T00:00:00.000Z", outletname: "Lawspet", store_slug: "9rJMC", total_bill_amount: "123456.789", total_sales_return: "-250.5", loyalty: "120" },
        { date: "2026-10-16", outletname: null, store_slug: "zzz", total_bill_amount: 10, total_sales_return: 0, loyalty: null },
      ],
      "2026-10-16"
    );
    assert.deepEqual(rows, [
      { date: "2026-10-16", outletname: "Lawspet", store_slug: "9rJMC", total_bill_amount: 123456.79, total_sales_return: -250.5, loyalty: 120 },
      { date: "2026-10-16", outletname: "zzz", store_slug: "zzz", total_bill_amount: 10, total_sales_return: 0, loyalty: 0 },
    ]);
  });
});

describe("the pull", () => {
  it("asks SPECTRA as product mandapam, with the configured URL and key", async () => {
    const calls = [];
    const fakeHttp = async (req) => {
      calls.push(req);
      return { data: { data: [{ date: "2026-10-16", outletname: "Lawspet", store_slug: "9rJMC", total_bill_amount: 5, total_sales_return: 0, loyalty: 1 }], pagination: { has_next: false } } };
    };
    const spectra = spectraFactory({ baseUrl: "https://rp.example", apiKey: "k", product: "mandapam", pageSize: 2000, timeoutMs: 1000 }, fakeHttp);
    const r = await salesFactory(spectra).daySales("2026-10-16");
    assert.equal(r.code, 200);
    assert.equal(r.rows.length, 1);
    assert.equal(calls[0].url, "https://rp.example/spectra/query");
    assert.equal(calls[0].headers["X-Product"], "mandapam");
    assert.equal(calls[0].headers["X-Authentication"], "k");
  });

  it("the server builds the sales client with the sales product, not the purchase one", () => {
    const fs = require("fs");
    const server = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    assert.match(server, /require\("\.\/usecase\/retailpilot_sales"\)\(\s*require\("\.\/services\/retailpilot_spectra"\)\(\{\s*\.\.\.retailPilotConfig,\s*baseUrl: retailPilotConfig\.salesBaseUrl,\s*apiKey: retailPilotConfig\.salesApiKey,\s*product: retailPilotConfig\.salesProduct,/);
    assert.equal(require("../config/retailpilot").salesProduct, "Mandapam", "fixed, whatever .env says");
  });

  it("sales use their own SPECTRA key and URL when set; the purchase ones otherwise", () => {
    const load = (env) => {
      const saved = { ...process.env };
      for (const k of ["RETAILPILOT_SPECTRA_URL", "RETAILPILOT_SPECTRA_KEY", "RETAILPILOT_SALES_SPECTRA_URL", "RETAILPILOT_SALES_SPECTRA_KEY"]) delete process.env[k];
      Object.assign(process.env, env);
      const path = require.resolve("../config/retailpilot");
      delete require.cache[path];
      const c = require(path);
      delete require.cache[path];
      process.env = saved;
      return c;
    };
    const own = load({ RETAILPILOT_SPECTRA_URL: "https://runway.example/", RETAILPILOT_SPECTRA_KEY: "rk", RETAILPILOT_SALES_SPECTRA_URL: "https://pos.example/", RETAILPILOT_SALES_SPECTRA_KEY: "sk" });
    assert.deepEqual([own.salesBaseUrl, own.salesApiKey, own.baseUrl, own.apiKey], ["https://pos.example", "sk", "https://runway.example", "rk"]);
    const shared = load({ RETAILPILOT_SPECTRA_URL: "https://runway.example", RETAILPILOT_SPECTRA_KEY: "rk" });
    assert.deepEqual([shared.salesBaseUrl, shared.salesApiKey], ["https://runway.example", "rk"]);
  });

  it("not configured, a bad day, or a SPECTRA failure: a reason, never a throw", async () => {
    const off = salesFactory({ isConfigured: () => false });
    assert.equal((await off.daySales("2026-10-16")).code, 400);
    assert.equal((await off.daySales("16/10/2026")).code, 422);
    const failing = salesFactory({ isConfigured: () => true, queryAll: async () => { throw new Error("SPECTRA error: relation does not exist"); } });
    const r = await failing.daySales("2026-10-16");
    assert.equal(r.code, 502);
    assert.match(r.msg, /relation does not exist/);
  });

  it("GET /reconciliation/retailpilot-sales?date= returns the rows", async () => {
    const asked = [];
    const sales = { daySales: async (d) => { asked.push(d); return { code: 200, date: d, rows: [] }; } };
    const app = express();
    app.use("/reconciliation", require("../routes/reconciliation")({}, sales).getRouter());
    const server = app.listen(0);
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${server.address().port}/reconciliation/retailpilot-sales?date=2026-10-16`, (res) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve(JSON.parse(t)));
        }).on("error", reject);
      });
      assert.deepEqual(body, { code: 200, date: "2026-10-16", rows: [] });
      assert.deepEqual(asked, ["2026-10-16"]);
    } finally {
      server.close();
    }
  });
});
