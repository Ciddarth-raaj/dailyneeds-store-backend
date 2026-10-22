/**
 * Article Store Master report: the rows, a real .xlsx built end to end from
 * fake SPECTRA clients, and the endpoints behind the real permission
 * middleware.
 *
 *   node --test utils/article_store_master.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const ExcelJS = require("exceljs");

const { buildReport, storeColumns, levelOf, attributeValue, MASTERHUB_QUERIES, RUNWAY_QUERIES } = require("./article_store_master");
const reportFactory = require("../usecase/article_store_master");
const routesFactory = require("../routes/article_store_master");
const buildPermissions = require("../middlewares/permissions");

const DATA = {
  articles: [
    { article_id: 51156, article_name: "zyro zero sugar tonic water drink 250ml tin", hsn_code: "22029990", preparation_type: "trade_as_is", purchase_measure: "CASE", sales_measure: "NOS" },
    { article_id: 42953, article_name: "zzoy toy wooden puzzle", hsn_code: "48202000", preparation_type: "trade_as_is", purchase_measure: "NOS", sales_measure: "NOS" },
    { article_id: 900, article_name: "sugar 1kg repack", hsn_code: "1701", preparation_type: "repack", purchase_measure: "KG", sales_measure: "NOS" },
    { article_id: 901, article_name: "sugar bulk 50kg", hsn_code: "1701", preparation_type: "bulk", purchase_measure: "KG", sales_measure: "KG" },
  ],
  taxonomy: [
    { article_id: 51156, level_id: "department-cpg", hierarchy_id: 10, hierarchy_name: "beverages", level_name: "Department" },
    { article_id: 51156, level_id: "category-cpg", hierarchy_id: 11, hierarchy_name: "soft drinks", level_name: "Category" },
    { article_id: 51156, level_id: "subcategory-cpg", hierarchy_id: 3534, hierarchy_name: "soda & cocktail mix", level_name: "Sub-category" },
    { article_id: 51156, level_id: "brand-cpg", hierarchy_id: 77, hierarchy_name: "zyro", level_name: "Brand" },
    { article_id: 42953, level_id: "department-cpg", hierarchy_id: 20, hierarchy_name: "household needs", level_name: null },
  ],
  suppliers: [
    { article_id: 51156, store_id: null, supplier_id: "10001" },
    { article_id: 42953, store_id: "dn1slug", supplier_id: "10002" },
    { article_id: 42953, store_id: "whslug", supplier_id: "10003" },
  ],
  vendors: [
    { id: "10001", name: "akshaya agencies pvt ltd", trade_name: "akshaya agencies (zyro)" },
    { id: "10002", name: "x", trade_name: "dn1 supplier" },
    { id: "10003", name: "metro home need (toys)", trade_name: "" },
  ],
  articleTax: [
    { article_id: 51156, tax_code: 40 },
    { article_id: 900, tax_code: 5 },
  ],
  hsnTax: [
    { code: "hl-48202000-5", hsn_code: "48202000", tax_code: 5 },
    { code: "hl-0401-12", hsn_code: "0401", tax_code: 12 },
  ],
  taxRates: [
    { code: 5, description: "GST 5%" },
    { code: 40, description: "GST 40%" },
  ],
  attributes: [
    { article_id: 51156, store_id: null, attr_id: "purchase_allowed", attr_value: "true" },
    { article_id: 51156, store_id: "dn1slug", attr_id: "purchase_allowed", attr_value: "false" },
    { article_id: 51156, store_id: "dn1slug", attr_id: "allow_negative", attr_value: "Y" },
    { article_id: 51156, store_id: "whslug", attr_id: "allow_negative", attr_value: "N" },
    { article_id: 51156, store_id: null, attr_id: "purchase_type", attr_value: "FT" },
    { article_id: 42953, store_id: "dn1slug", attr_id: "allow_negative", attr_value: "Y" },
    { article_id: 42953, store_id: "dn2slug", attr_id: "allow_negative", attr_value: "Y" },
    { article_id: 900, store_id: "dn1slug", attr_id: "allow_negative", attr_value: "Y" },
    { article_id: 900, store_id: "dn2slug", attr_id: "allow_negative", attr_value: "N" },
  ],
  preparation: [{ prepared_item: 900, ingredient_item: 901, ingredient_measure: 1 }],
  stores: [
    { slug: "whslug", shortname: "Wh", name: "Warehouse", type: "warehouse", is_active: true },
    { slug: "dn2slug", shortname: "Dn2", name: "Store 2", type: "store", is_active: true },
    { slug: "dn1slug", shortname: "Dn1", name: "Store 1", type: "store", is_active: true },
    { slug: "oldslug", shortname: "Old", name: "Closed", type: "store", is_active: false },
  ],
  stock: [
    { store_id: "dn1slug", article_id: 51156, quantity: "4" },
    { store_id: "dn2slug", article_id: 51156, quantity: 8.5 },
    { store_id: "whslug", article_id: 51156, quantity: 24 },
    { store_id: "dn2slug", article_id: 42953, quantity: 1 },
    { store_id: "oldslug", article_id: 42953, quantity: 0 },
  ],
};

describe("the rows", () => {
  const report = buildReport(DATA);
  const byId = Object.fromEntries(report.rows.map((r) => [r.article_id, r]));

  it("one row per article, in masterhub's order", () => {
    assert.deepEqual(report.rows.map((r) => r.article_id), [51156, 42953, 900, 901]);
  });

  it("the catalogue columns: names, taxonomy, HSN, tax as the old report wrote it, units", () => {
    const r = byId[51156];
    assert.equal(r.article_name, "zyro zero sugar tonic water drink 250ml tin");
    assert.deepEqual([r.department_name, r.category_name, r.subcategory_name, r.brand_name, r.subcategory_id], ["beverages", "soft drinks", "soda & cocktail mix", "zyro", 3534]);
    assert.deepEqual([r.hsn_code, r.tax, r.pur_uom, r.supply_uom], ["22029990", "GST 40%", "CASE", "NOS"]);
    assert.equal(byId[42953].department_name, "household needs", "a level known by its id when the name is missing");
    assert.equal(byId[42953].tax, "GST 5%", "not in derived.article_master: its HSN code's rate");
    assert.equal(byId[900].tax, "GST 5%");
    assert.equal(byId[901].tax, "", "no tax code and no HSN rate: blank, not a guess");
  });

  it("an article whose hsn_code is a linker record's id: that record's real HSN and tax", () => {
    const r = buildReport({ ...DATA, articles: [{ article_id: 7, article_name: "milk", hsn_code: "hl-0401-12" }] }).rows[0];
    assert.deepEqual([r.hsn_code, r.tax], ["0401", "GST 12%"]);
  });

  it("supplier: the all-stores one; else the warehouse's", () => {
    assert.equal(byId[51156].supplier_name, "akshaya agencies (zyro)");
    assert.equal(byId[42953].supplier_name, "metro home need (toys)", "warehouse rule, and the legal name when there is no trade name");
    assert.equal(byId[900].supplier_name, "");
  });

  it("a repack shows its bulk item, its name and the quantity; others 0 as in the old report", () => {
    assert.deepEqual([byId[900].purchase_item, byId[900].purchase_item_name, byId[900].repackage_conversion], [901, "sugar bulk 50kg", 1]);
    assert.deepEqual([byId[51156].purchase_item, byId[51156].purchase_item_name, byId[51156].repackage_conversion], [0, "", 0]);
  });

  it("stock per store, retail stores first then the warehouse, and the total", () => {
    assert.deepEqual(report.stores.map((s) => s.header), ["Dn1", "Dn2", "Wh"], "a closed store with no stock is left out");
    const r = byId[51156];
    assert.deepEqual([r["stock:dn1slug"], r["stock:dn2slug"], r["stock:whslug"], r.total], [4, 8.5, 24, 36.5]);
    assert.deepEqual([byId[901]["stock:dn1slug"], byId[901].total], [0, 0]);
  });

  it("the columns are in the old report's order, without MRP, cost or sale rate", () => {
    const headers = report.columns.map((c) => c.header);
    assert.deepEqual(headers, [
      "article_id", "article_name", "supplier_name", "brand_name", "department_name", "category_name", "subcategory_name",
      "allow_purchase", "purchase_type", "preparation_type", "repackage_conversion", "purchase_item", "purchase_item_name", "subcategory_id", "Hsn code", "Tax",
      "Dn1", "Dn2", "Wh", "Total", "Pur uom", "Supply uom",
    ]);
    assert.ok(!headers.some((h) => /mrp|cost|sale_rate/i.test(h)));
  });

  it("allow purchase and purchase type: the article-wide value, else the warehouse's, else the stores' if they agree", () => {
    assert.deepEqual([byId[51156].allow_purchase, byId[51156].purchase_type], ["true", "FT"]);
    assert.equal(byId[51156].allow_negative, undefined, "allow negative is not in the report");
    assert.equal(attributeValue([{ store_id: "dn1slug", attr_value: "Y" }, { store_id: "whslug", attr_value: "N" }], new Set(["whslug"])), "N", "the warehouse's");
    assert.equal(attributeValue([{ store_id: "a", attr_value: "Y" }, { store_id: "b", attr_value: "Y" }], new Set()), "Y", "every store agrees");
    assert.equal(attributeValue([{ store_id: "a", attr_value: "Y" }, { store_id: "b", attr_value: "N" }], new Set()), "mixed");
    assert.deepEqual([byId[901].allow_purchase, byId[901].purchase_type], ["", ""]);
  });

  it("a closed store that still holds stock keeps its column, so Total misses nothing", () => {
    const cols = storeColumns(DATA.stores, [...DATA.stock, { store_id: "oldslug", article_id: 1, quantity: 3 }]);
    assert.ok(cols.some((c) => c.header === "Old"));
  });

  it("taxonomy levels by name or id", () => {
    assert.equal(levelOf({ level_name: "Sub-category" }), "subcategory");
    assert.equal(levelOf({ level_id: "brand-cpg" }), "brand");
    assert.equal(levelOf({ level_id: "manufacturer-cpg" }), null);
  });

  it("the queries read only whitelisted tables, each ordered for stable paging", () => {
    const all = [...Object.values(MASTERHUB_QUERIES), ...Object.values(RUNWAY_QUERIES)];
    for (const q of all) assert.match(q, /ORDER BY/);
    assert.match(MASTERHUB_QUERIES.articles, /FROM public\.articles a/, "every article, not derived.article_master's few");
    assert.match(MASTERHUB_QUERIES.articleTax, /FROM derived\.article_master/);
    assert.match(MASTERHUB_QUERIES.hsnTax, /FROM constants\.hsn_tax_linker/);
    assert.match(MASTERHUB_QUERIES.suppliers, /FROM derived\.article_store_suppliers/);
    assert.match(MASTERHUB_QUERIES.taxRates, /FROM constants\.tax_rates/);
    assert.match(MASTERHUB_QUERIES.attributes, /FROM derived\.article_store_attributes a\s+WHERE a\.attr_id IN \('purchase_allowed', 'purchase_type'\)/);
    assert.doesNotMatch(MASTERHUB_QUERIES.attributes, /allow_negative/, "not wanted");
    assert.match(RUNWAY_QUERIES.stock, /FROM public\.batch_stock_positions p\s+JOIN public\.inventory_batches b/);
    assert.ok(!all.some((q) => /\b(mrp|net_cost|sale_rate|cost_master|selling_master)\b/i.test(q)), "no prices, for now");
  });
});

const fakeClient = (byQuery, calls) => ({
  isConfigured: () => true,
  queryAll: async (q) => {
    calls.push(q);
    for (const [key, query] of Object.entries({ ...MASTERHUB_QUERIES, ...RUNWAY_QUERIES })) {
      if (q === query) return byQuery[key];
    }
    throw new Error("unexpected query");
  },
});

describe("the file", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("builds a real .xlsx named for the India day, with the header and every row", async () => {
    const calls = [];
    const r = reportFactory(fakeClient(DATA, calls), fakeClient(DATA, calls), { dir, now: () => new Date("2026-10-22T00:30:00Z") });
    const res = await r.build();
    assert.equal(res.code, 200, res.msg);
    assert.equal(res.file, "article-store-master-2026-10-22.xlsx", "00:30 UTC is 06:00 IST on the 22nd");
    assert.equal(res.rows, 4);
    assert.equal(calls.length, Object.keys(MASTERHUB_QUERIES).length + 1);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, res.file));
    const ws = wb.worksheets[0];
    assert.equal(ws.getRow(1).getCell(1).value, "article_id");
    assert.equal(ws.getRow(1).getCell(17).value, "Dn1");
    assert.equal(ws.getRow(2).getCell(2).value, "zyro zero sugar tonic water drink 250ml tin");
    assert.equal(ws.getRow(2).getCell(20).value, 36.5);
    assert.equal(ws.getRow(2).getCell(8).value, "true", "allow_purchase");
    assert.equal(ws.rowCount, 5);
    assert.equal(r.status().latest.file, res.file);
  });

  it("keeps the last seven days; a failed build keeps yesterday's file and reports why", async () => {
    for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `article-store-master-2026-09-${String(d).padStart(2, "0")}.xlsx`), "x");
    const r = reportFactory(fakeClient(DATA, []), fakeClient(DATA, []), { dir, now: () => new Date("2026-10-23T01:00:00Z") });
    assert.equal((await r.build()).code, 200);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx")).sort();
    assert.equal(files.length, 7);
    assert.equal(files[files.length - 1], "article-store-master-2026-10-23.xlsx");

    const failing = reportFactory({ isConfigured: () => true, queryAll: async () => { throw new Error("SPECTRA error: whitelist_violation"); } }, fakeClient(DATA, []), { dir });
    const res = await failing.build();
    assert.equal(res.code, 502);
    assert.equal(failing.status().last_error, "SPECTRA error: whitelist_violation");
    assert.equal(failing.status().latest.file, "article-store-master-2026-10-23.xlsx", "the last good file is still downloadable");
  });

  it("an empty article list never replaces a good file", async () => {
    const r = reportFactory(fakeClient({ ...DATA, articles: [] }, []), fakeClient(DATA, []), { dir });
    const res = await r.build();
    assert.equal(res.code, 502);
    assert.match(res.msg, /no articles/);
  });

  it("two refreshes at once run one build", async () => {
    let calls = 0;
    const slow = { isConfigured: () => true, queryAll: async (q) => { calls += 1; await new Promise((s) => setTimeout(s, 5)); return fakeClient(DATA, []).queryAll(q); } };
    const r = reportFactory(slow, fakeClient(DATA, []), { dir });
    const [a, b] = await Promise.all([r.build(), r.build()]);
    assert.equal(a, b);
    assert.equal(calls, Object.keys(MASTERHUB_QUERIES).length);
  });
});

describe("the endpoints", () => {
  let server;
  let base;
  let built = 0;
  let dir;
  let report;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-r-"));
    report = reportFactory(fakeClient(DATA, []), fakeClient(DATA, []), { dir });
    await report.build();
    const realBuild = report.build.bind(report);
    report.build = () => { built += 1; return realBuild(); };
    const GRANTS = { 10: ["view_products"], 11: ["view_purchases"] };
    const permissions = buildPermissions({ getPermissionById: async (d) => (GRANTS[d] || []).map((k) => ({ permission_key: k })) });
    const app = express();
    app.use((req, res, next) => {
      const s = req.headers["x-test-session"];
      if (s) req.decoded = JSON.parse(s);
      next();
    });
    app.use("/article-store-master", routesFactory(report, permissions).getRouter());
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = (method, p, session) =>
    new Promise((resolve, reject) => {
      const req = http.request(`${base}${p}`, { method, headers: session ? { "x-test-session": JSON.stringify(session) } : {} }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], disposition: res.headers["content-disposition"], body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });

  it("the key is view_products, the All Products one", () => {
    assert.equal(routesFactory.VIEW_ARTICLE_STORE_MASTER, "view_products");
  });

  it("without view_products: refused, nothing built", async () => {
    built = 0;
    assert.equal((await call("GET", "/article-store-master/download", null)).status, 401);
    assert.equal((await call("GET", "/article-store-master/download", { employee_id: 5, designation_id: 11, user_type: 1 })).status, 403);
    assert.equal((await call("POST", "/article-store-master/refresh", { employee_id: 5, designation_id: 11, user_type: 1 })).status, 403);
    assert.equal(built, 0);
  });

  it("with it: status, the .xlsx download, and a refresh", async () => {
    const who = { employee_id: 6, designation_id: 10, user_type: 1 };
    const status = JSON.parse((await call("GET", "/article-store-master/status", who)).body);
    assert.equal(status.code, 200);
    assert.match(status.latest.file, /^article-store-master-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const dl = await call("GET", "/article-store-master/download", who);
    assert.equal(dl.status, 200);
    assert.match(dl.disposition, /attachment; filename="article-store-master-/);
    assert.equal(dl.body.slice(0, 2).toString(), "PK", "an xlsx (zip) file");
    built = 0;
    assert.equal(JSON.parse((await call("POST", "/article-store-master/refresh", who)).body).started, true);
    assert.equal(built, 1);
    assert.equal((await report.running)?.code ?? 200, 200, "the background build finishes");
  });

  it("an admin needs no grant", async () => {
    assert.equal((await call("GET", "/article-store-master/download", { employee_id: 1, user_type: 2 })).status, 200);
  });
});
