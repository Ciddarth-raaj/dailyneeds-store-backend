/**
 * STO DATE RANGE AND CALENDAR, AS REAL SQL.
 *
 *   STO_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/stock_transfer_out.mysql.test.js
 *
 * SKIPPED unless `STO_TEST_MYSQL` names a SCRATCH database: the suite creates
 * the two STO view tables and sto_check under their production names, fills
 * them and drops them again.
 *
 * What the in-memory tests cannot show:
 *   - the header range query is answered from an index on the date column
 *     (a `range` plan, not a scan), which only holds because the column is
 *     compared bare;
 *   - an STO keeps its stored calendar day (GoFrugal writes Asia/Kolkata wall
 *     clock) whatever the driver `timezone` option, the MySQL session
 *     time_zone or the Node process TZ - the calendar day comes from
 *     DATE_FORMAT in MySQL and the range bounds are plain 'YYYY-MM-DD'.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const URL_ENV = process.env.STO_TEST_MYSQL;
const buildStoRepo = require("./stock_transfer_out");
const buildStoCheckRepo = require("./sto_check");
const buildStoUsecase = require("../usecase/stock_transfer_out");
const buildStoCheckUsecase = require("../usecase/sto_check");

const HDR = "medishopdb_Vw_StockTransferOut_hdr";
const DTL = "medishopdb_Vw_StockTransferOut_dtl";

function connect(extra = {}) {
  const mysql = require("mysql");
  const u = new URL(URL_ENV);
  return mysql.createPool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    connectionLimit: 2,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...extra,
  });
}

function q(pool, sql, params = []) {
  return new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

describe("STO range + calendar on MySQL", { skip: !URL_ENV && "set STO_TEST_MYSQL" }, () => {
  let admin;

  before(async () => {
    admin = connect();
    await q(admin, `DROP TABLE IF EXISTS ${HDR}, ${DTL}, sto_check, product_table`);
    await q(admin, `CREATE TABLE ${HDR} (Dn_no INT PRIMARY KEY, Dn_Ref_no INT NULL, DN_date DATETIME NOT NULL,
      Cust_Code VARCHAR(20), Cust_Name VARCHAR(100), Tot_Items INT, INDEX idx_dn_date (DN_date))`);
    await q(admin, `CREATE TABLE ${DTL} (Dn_no INT NOT NULL, Dn_sl_no INT NOT NULL, Item_Code INT, Item_qty DECIMAL(12,3),
      PRIMARY KEY (Dn_no, Dn_sl_no))`);
    await q(admin, `CREATE TABLE product_table (product_id INT PRIMARY KEY, de_name VARCHAR(100), de_display_name VARCHAR(100))`);
    await q(admin, `CREATE TABLE sto_check (dn_ref_no INT NOT NULL, product_id INT NOT NULL, file_qty INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (dn_ref_no, product_id))`);
    const rows = [
      [1, 11, "2026-08-31 23:50:00"],
      [2, 12, "2026-09-01 00:15:00"], // 18:45 UTC the previous day
      [3, 13, "2026-09-01 05:29:59"], // 23:59:59 UTC the previous day
      [4, 14, "2026-09-30 23:59:59"],
      [5, 15, "2026-10-01 00:00:00"],
    ];
    await q(admin, `INSERT INTO ${HDR} (Dn_no, Dn_Ref_no, DN_date, Cust_Code, Cust_Name, Tot_Items) VALUES ?`, [
      rows.map(([n, r, d]) => [n, r, d, "101", "Branch", 1]),
    ]);
    // Enough other history that a scan and an index range are distinguishable.
    const filler = [];
    for (let i = 0; i < 2000; i++) {
      filler.push([100 + i, 1000 + i, `2025-0${1 + (i % 8)}-1${i % 10} 12:00:00`, "101", "Branch", 1]);
    }
    await q(admin, `INSERT INTO ${HDR} (Dn_no, Dn_Ref_no, DN_date, Cust_Code, Cust_Name, Tot_Items) VALUES ?`, [filler]);
    await q(admin, `INSERT INTO ${DTL} VALUES ?`, [rows.map(([n]) => [n, 1, 901, 2])]);
    await q(admin, `INSERT INTO product_table VALUES (901, 'P901', NULL)`);
    await q(admin, `INSERT INTO sto_check (dn_ref_no, product_id, file_qty) VALUES (12, 901, 2), (14, 901, 1)`);
    await q(admin, `ANALYZE TABLE ${HDR}`);
  });

  after(async () => {
    if (!admin) return;
    await q(admin, `DROP TABLE IF EXISTS ${HDR}, ${DTL}, sto_check, product_table`);
    await new Promise((r) => admin.end(r));
  });

  const combos = [];
  for (const driverTz of ["local", "Z", "+05:30"]) {
    for (const sessionTz of ["+00:00", "+05:30"]) {
      for (const processTz of ["Asia/Kolkata", "UTC"]) combos.push({ driverTz, sessionTz, processTz });
    }
  }

  for (const c of combos) {
    it(`days hold with driver tz ${c.driverTz}, session ${c.sessionTz}, process ${c.processTz}`, async () => {
      const saved = process.env.TZ;
      process.env.TZ = c.processTz;
      const pool = connect({ timezone: c.driverTz });
      pool.on("connection", (conn) => conn.query(`SET time_zone = '${c.sessionTz}'`));
      try {
        const usecase = buildStoUsecase(
          buildStoRepo(pool),
          null,
          buildStoCheckUsecase(buildStoCheckRepo(pool))
        );
        assert.deepEqual(await usecase.getCalendar(2026, 9), [
          { date: "2026-09-01", total: 2, checked: 1, unchecked: 1 },
          { date: "2026-09-30", total: 1, checked: 1, unchecked: 0 },
        ]);
        assert.deepEqual(await usecase.getCalendar(2026, 8), [
          { date: "2026-08-31", total: 1, checked: 0, unchecked: 1 },
        ]);
        const day = await usecase.get({ from_date: "2026-09-01", to_date: "2026-09-01" });
        assert.deepEqual(day.map((h) => Number(h.Dn_no)).sort(), [2, 3]);
        const checked = await usecase.get({ is_checked: true, from_date: "2026-09-01", to_date: "2026-09-30" });
        assert.deepEqual(checked.map((h) => Number(h.Dn_no)).sort(), [2, 4]);
        assert.equal(checked.find((h) => Number(h.Dn_no) === 2).items[0].file_qty, 2);
      } finally {
        await new Promise((r) => pool.end(r));
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });
  }

  it("the header range is an index range, where DATE(col) was a scan", async () => {
    const [bare] = await q(admin, `EXPLAIN SELECT * FROM ${HDR} WHERE \`Dn_Date\` >= ? AND \`Dn_Date\` < ? ORDER BY Dn_no DESC`, [
      "2026-09-01",
      "2026-09-02",
    ]);
    assert.equal(bare.type, "range");
    assert.equal(bare.key, "idx_dn_date");
    const [wrapped] = await q(admin, `EXPLAIN SELECT * FROM ${HDR} WHERE DATE(\`Dn_Date\`) >= DATE(?) AND DATE(\`Dn_Date\`) <= DATE(?) ORDER BY Dn_no DESC`, [
      "2026-09-01",
      "2026-09-01",
    ]);
    assert.notEqual(wrapped.type, "range");
  });

  it("sto_check's primary key answers the batched dn_ref_no lookup", async () => {
    const [plan] = await q(admin, `EXPLAIN SELECT DISTINCT dn_ref_no FROM sto_check WHERE dn_ref_no IN (?, ?)`, [12, 14]);
    assert.equal(plan.key, "PRIMARY");
  });
});
