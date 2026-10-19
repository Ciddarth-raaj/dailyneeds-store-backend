/**
 *   RETAILPILOT_GRN_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/retailpilot_grn.mysql.test.js
 *
 * SKIPPED unless `RETAILPILOT_GRN_TEST_MYSQL` names a SCRATCH database: the
 * suite drops and recreates retailpilot_grn_headers / retailpilot_grn_lines.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.RETAILPILOT_GRN_TEST_MYSQL;
const UP = path.join(__dirname, "../migrations/mysql/migrations/sqls/20261209120000-retailpilot-grn-copy-up.sql");

const header = (slug, refno, day, at, fy = 2026) => ({
  invoice_slug: slug, refno, fy, store_id: "9rJMC", grn_date: day, entered_at: at,
  supplier_id: "7", supplier_name: "Supplier", amount: 100,
});
const line = (id, inv, no, product, price) => ({
  line_id: id, invoice_slug: inv, line_no: no, product_id: product, recd_qty: 1, free_qty: 0, mrp: 20,
  pur_rate: price, tax_per: 5, tax_amt: 1, pur_price: price + 1, sale_rate: price + 5, pur_amount: price + 1,
  disc_per: 0, disc_amt: 0,
});

describe("RetailPilot GRN copy over real SQL", { skip: !URL && "RETAILPILOT_GRN_TEST_MYSQL not set" }, () => {
  let pool, repo;
  const q = (sql) => new Promise((res, rej) => pool.query(sql, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    const mysql = require("mysql");
    pool = mysql.createPool(URL + (URL.includes("?") ? "&" : "?") + "multipleStatements=true");
    await q("DROP TABLE IF EXISTS retailpilot_grn_lines, retailpilot_grn_headers");
    await q(fs.readFileSync(UP, "utf8"));
    repo = require("./retailpilot_grn")(pool);
  });
  after(() => pool && pool.end());

  it("headers: upsert, and GRNs gone from RetailPilot are removed with their lines", async () => {
    await repo.replaceHeaders("9rJMC", [
      header("INV-a", "6600", "2026-10-18", "2026-10-18 09:00:00"),
      header("INV-b", "6601", "2026-10-19", "2026-10-19 09:00:00"),
      header("INV-c", "6602", "2026-10-19", "2026-10-19 10:00:00"),
    ]);
    await repo.replaceLines(["INV-a", "INV-b", "INV-c"], [
      line("L1", "INV-a", 1, 5, 10), line("L2", "INV-b", 1, 5, 12), line("L3", "INV-b", 2, 6, 30), line("L4", "INV-c", 1, 9, 1),
    ]);
    const r = await repo.replaceHeaders("9rJMC", [
      header("INV-a", "6600", "2026-10-18", "2026-10-18 09:00:00"),
      { ...header("INV-b", "6601", "2026-10-19", "2026-10-19 09:00:00"), supplier_name: "Renamed" },
    ]);
    assert.equal(r.removed, 1);
    assert.deepEqual((await q("SELECT line_id FROM retailpilot_grn_lines ORDER BY line_id")).map((x) => x.line_id), ["L1", "L2", "L3"]);
    const [b] = await repo.searchHeaders("9rJMC", "6601");
    assert.equal(b.supplier_name, "Renamed");
    assert.equal(Number(b.product_count), 2);
  });

  it("lines of a synced GRN are replaced: removed lines go", async () => {
    await repo.replaceLines(["INV-b"], [line("L2", "INV-b", 1, 5, 13)]);
    const lines = await repo.linesOf("INV-b");
    assert.deepEqual(lines.map((l) => [l.MMD_MRC_SL_NO, Number(l.MMD_PUR_RATE)]), [["L2", 13]]);
  });

  it("readers: by day, by GRN No, range lines, previous purchase", async () => {
    assert.deepEqual((await repo.listHeaders("9rJMC", "2026-10-19", "2026-10-19")).map((h) => h.mmh_mrc_refno), ["6601"]);
    assert.deepEqual((await repo.listHeaders("9rJMC", null, null)).map((h) => h.mmh_mrc_dt), ["2026-10-19", "2026-10-18"]);
    const h = await repo.headerByRefno("9rJMC", "6601");
    assert.equal(h.mmh_mrc_no, "INV-b");
    assert.equal(h.entered_at, "2026-10-19 09:00:00");
    assert.equal(await repo.headerByRefno("9rJMC", "66' OR '1"), null);
    const range = await repo.linesByRange("9rJMC", "2026-10-18", "2026-10-19");
    assert.deepEqual(range.map((r) => [r.mmh_mrc_refno, r.MMD_MRC_SL_NO]), [["6601", "L2"], ["6600", "L1"]]);
    const prev = await repo.previousLines("9rJMC", [5, 6], h.entered_at);
    assert.deepEqual(prev.map((p) => [Number(p.article_id), Number(p.basic_cost)]), [[5, 10]]);
  });
});
