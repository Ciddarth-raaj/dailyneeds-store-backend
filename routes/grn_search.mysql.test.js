/**
 * GRN No SEARCH OVER REAL SQL - the repository query and the boot-time index
 * against a MySQL/MariaDB holding GoFrugal-shaped GRN tables.
 *
 *   GRN_SEARCH_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test routes/grn_search.mysql.test.js
 *
 * SKIPPED unless `GRN_SEARCH_TEST_MYSQL` names a SCRATCH database: the suite
 * drops and creates the medishopdb_MED_MRC_* tables in it.
 *
 * What only real SQL can show: the exact GRN ranks first, a GRN from another
 * month or year is found, `%`/`_` in the term match literally, the line count
 * survives the capped inner query, and the GRN No index is created once and
 * then used by the search.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.GRN_SEARCH_TEST_MYSQL;

const SCHEMA = (refnoType) => [
  "DROP TABLE IF EXISTS medishopdb_MED_MRC_HDR, medishopdb_MED_MRC_DTL, medishopdb_MED_DISTRIBUTOR_MAST",
  `CREATE TABLE medishopdb_MED_MRC_HDR (
     MMH_MRC_NO INT PRIMARY KEY,
     MMH_MRC_REFNO ${refnoType},
     MMH_MRC_DT DATETIME,
     MMH_DIST_CODE INT,
     MMH_MRC_AMT DECIMAL(12,2)
   ) ENGINE=InnoDB`,
  `CREATE TABLE medishopdb_MED_MRC_DTL (
     MMD_MRC_NO INT, MMD_MRC_SL_NO INT, MMD_ITEM_CODE INT,
     PRIMARY KEY (MMD_MRC_NO, MMD_MRC_SL_NO)
   ) ENGINE=InnoDB`,
  `CREATE TABLE medishopdb_MED_DISTRIBUTOR_MAST (
     MDM_DIST_CODE INT PRIMARY KEY, MDM_DIST_NAME VARCHAR(80)
   ) ENGINE=InnoDB`,
  "INSERT INTO medishopdb_MED_DISTRIBUTOR_MAST VALUES (1, 'ACME TRADERS'), (2, 'SUN AGENCIES')",
];

// 5972 is from September; the screen in the story is on 02/10/2026.
const GRNS = [
  [1, "5901", "2025-08-03 10:00:00", 2, 120.5, 1],
  [2, "5972", "2026-09-18 11:00:00", 1, 999.0, 3],
  [3, "59721", "2026-10-01 09:00:00", 2, 50.0, 2],
  [4, "6100", "2026-10-02 09:30:00", 1, 75.0, 1],
  [5, "8%_1", "2026-10-02 10:00:00", 1, 10.0, 1],
  [6, "8001", "2026-10-02 10:05:00", 1, 10.0, 1],
];

let pool;
let query;

async function load(refnoType) {
  for (const sql of SCHEMA(refnoType)) await query(sql);
  for (const [no, refno, dt, dist, amt, lines] of GRNS) {
    if (/INT/.test(refnoType) && !/^\d+$/.test(refno)) continue;
    await query("INSERT INTO medishopdb_MED_MRC_HDR VALUES (?, ?, ?, ?, ?)", [no, refno, dt, dist, amt]);
    for (let sl = 1; sl <= lines; sl += 1) {
      await query("INSERT INTO medishopdb_MED_MRC_DTL VALUES (?, ?, ?)", [no, sl, 100 + sl]);
    }
  }
}

describe("GRN No search over real SQL", { skip: !URL && "GRN_SEARCH_TEST_MYSQL not set" }, () => {
  let repo;

  before(async () => {
    const mysql = require("mysql");
    pool = mysql.createPool(URL);
    query = (sql, params = []) =>
      new Promise((resolve, reject) =>
        pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
      );
    repo = require("../repository/stock_received")(null, pool);
    await load("VARCHAR(20)");
  });

  after(() => new Promise((resolve) => (pool ? pool.end(resolve) : resolve())));

  it("finds a GRN from another month with the list's row shape", async () => {
    const rows = await repo.searchGrnHeaders("5972", 51);
    assert.deepEqual(rows[0], {
      mmh_mrc_no: 2,
      mmh_mrc_refno: "5972",
      mmh_mrc_dt: "2026-09-18",
      mmh_dist_code: "1",
      supplier_name: "ACME TRADERS",
      mmh_mrc_amt: 999,
      product_count: 3,
    });
  });

  it("ranks the exact GRN above newer prefix matches", async () => {
    const rows = await repo.searchGrnHeaders("5972", 51);
    assert.deepEqual(rows.map((r) => r.mmh_mrc_refno), ["5972", "59721"]);
  });

  it("matches a partial number across years, newest first", async () => {
    const rows = await repo.searchGrnHeaders("59", 51);
    assert.deepEqual(rows.map((r) => r.mmh_mrc_refno), ["59721", "5972", "5901"]);
    assert.deepEqual(rows.map((r) => r.product_count), [2, 3, 1]);
  });

  it("is a prefix match, not a contains match", async () => {
    assert.deepEqual(await repo.searchGrnHeaders("72", 51), []);
  });

  it("treats % and _ in the term literally", async () => {
    assert.deepEqual((await repo.searchGrnHeaders("8%", 51)).map((r) => r.mmh_mrc_refno), ["8%_1"]);
    assert.deepEqual((await repo.searchGrnHeaders("8_", 51)).map((r) => r.mmh_mrc_refno), []);
  });

  it("caps the rows before counting lines", async () => {
    const rows = await repo.searchGrnHeaders("5", 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.mmh_mrc_refno), ["59721", "5972"]);
  });

  it("adds the GRN No index on boot, once, and the search uses it", async () => {
    const { ensureGofrugalIndexes } = require("../utils/ensureGofrugalIndexes");
    const indexes = async () =>
      (await query("SHOW INDEX FROM medishopdb_MED_MRC_HDR WHERE Column_name = 'MMH_MRC_REFNO'"))
        .map((r) => r.Key_name);

    assert.deepEqual(await indexes(), []);
    await ensureGofrugalIndexes(pool);
    assert.deepEqual(await indexes(), ["idx_med_mrc_hdr_mrc_refno"]);
    await ensureGofrugalIndexes(pool);
    assert.deepEqual(await indexes(), ["idx_med_mrc_hdr_mrc_refno"], "idempotent");

    const plan = await query(
      "EXPLAIN SELECT MMH_MRC_NO FROM medishopdb_MED_MRC_HDR FORCE INDEX (idx_med_mrc_hdr_mrc_refno) WHERE MMH_MRC_REFNO LIKE ?",
      ["5972%"]
    );
    assert.equal(plan[0].key, "idx_med_mrc_hdr_mrc_refno");
    assert.equal(plan[0].type, "range");
  });

  it("does not add a second index when one already leads with MMH_MRC_REFNO", async () => {
    await load("VARCHAR(20)");
    await query("ALTER TABLE medishopdb_MED_MRC_HDR ADD INDEX gofrugal_own (MMH_MRC_REFNO, MMH_MRC_DT)");
    const { ensureGofrugalIndexes } = require("../utils/ensureGofrugalIndexes");
    await ensureGofrugalIndexes(pool);
    const names = (await query("SHOW INDEX FROM medishopdb_MED_MRC_HDR WHERE Column_name = 'MMH_MRC_REFNO'"))
      .map((r) => r.Key_name);
    assert.deepEqual(names, ["gofrugal_own"]);
  });

  it("still works if GoFrugal stores the GRN No as a number", async () => {
    await load("INT");
    const rows = await repo.searchGrnHeaders("5972", 51);
    assert.deepEqual(rows.map((r) => String(r.mmh_mrc_refno)), ["5972", "59721"]);
  });
});
