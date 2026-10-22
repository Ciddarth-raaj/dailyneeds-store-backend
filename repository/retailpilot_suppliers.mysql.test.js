/**
 * The RetailPilot supplier switch against real MySQL, with production's
 * foreign keys: product_table.distributor_id -> product_distributor_master.cid
 * and advance_requests / credit_purchases / lr_followup.distributor_code ->
 * product_distributor_master.mdm_dist_code.
 *
 *   RP_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/retailpilot_suppliers.mysql.test.js
 *
 * SKIPPED unless RP_TEST_MYSQL names a SCRATCH database: it drops and
 * creates the tables it uses.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const repoFactory = require("./retailpilot_suppliers");
const { supplierRows, RP_CODE_BASE } = require("../utils/retailpilot_suppliers");

const URL = process.env.RP_TEST_MYSQL;

describe("RetailPilot supplier switch, as SQL", { skip: !URL && "RP_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  const q = (sql, params = []) => new Promise((res, rej) => pool.query(sql, params, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    pool = require("mysql").createPool(`${URL}?multipleStatements=true`);
    for (const t of ["lr_followup", "credit_purchases", "advance_requests", "product_table", "product_distributor", "product_distributor_master"]) {
      await q(`DROP TABLE IF EXISTS ${t}`);
    }
    await q(`CREATE TABLE product_distributor_master (
      mdm_dist_code INT NOT NULL, mdm_dist_name VARCHAR(255) NULL, mdm_short_name VARCHAR(255) NULL,
      cid VARCHAR(64) NOT NULL, mdm_tag VARCHAR(16) NULL, holding_days INT NULL,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (cid), UNIQUE KEY uk_code (mdm_dist_code)) ENGINE=InnoDB`);
    await q(`CREATE TABLE product_distributor (
      mdm_dist_code VARCHAR(64) NOT NULL PRIMARY KEY, cid VARCHAR(64) NULL, buyer_id INT NULL,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    await q(`CREATE TABLE product_table (
      product_id INT PRIMARY KEY, retailpilot_article_id INT NULL, distributor_id VARCHAR(64) NULL,
      CONSTRAINT fk_pt_dist FOREIGN KEY (distributor_id) REFERENCES product_distributor_master (cid)) ENGINE=InnoDB`);
    for (const t of ["advance_requests", "credit_purchases", "lr_followup"]) {
      await q(`CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, distributor_code INT NULL,
        CONSTRAINT fk_${t}_dist FOREIGN KEY (distributor_code) REFERENCES product_distributor_master (mdm_dist_code)) ENGINE=InnoDB`);
    }

    // The old DNDS / GoFrugal list: 3 suppliers, one used by an LR follow-up.
    await q(`INSERT INTO product_distributor_master (cid, mdm_dist_code, mdm_dist_name, mdm_tag, holding_days) VALUES
      ('C10', 10, 'Sri Balaji Traders', 'a', 7), ('C11', 11, 'Kaveri Foods', 'a', 5), ('C12', 12, 'Old Unused', 'a', NULL)`);
    await q(`INSERT INTO product_distributor (mdm_dist_code, cid, buyer_id) VALUES ('10', 'C10', 501), ('11', 'C11', 502)`);
    await q(`INSERT INTO product_table (product_id, retailpilot_article_id, distributor_id) VALUES
      (1, 51156, 'C10'), (2, 42953, 'C11'), (3, NULL, 'C12'), (4, 900, NULL)`);
    await q(`INSERT INTO lr_followup (distributor_code) VALUES (11)`);
    repo = repoFactory(pool);
  });
  after(() => pool.end());

  const vendors = supplierRows([
    { id: "10001", name: "akshaya agencies pvt ltd", trade_name: "akshaya agencies (zyro)", is_active: true },
    { id: "10002", name: "metro home need", trade_name: "metro home need (toys)", is_active: true },
  ]).rows;
  const supplierOf = new Map([["51156", "RP10001"], ["42953", "RP10002"]]);
  const snapshot = async () => [
    await q("SELECT cid, mdm_dist_code, mdm_tag, holding_days FROM product_distributor_master ORDER BY cid"),
    await q("SELECT * FROM product_table ORDER BY product_id"),
    await q("SELECT mdm_dist_code, cid, buyer_id FROM product_distributor ORDER BY mdm_dist_code"),
  ];

  it("a dry run reports what the switch would do and changes nothing", async () => {
    const before = await snapshot();
    const r = await repo.apply(vendors, supplierOf, { dryRun: true });
    assert.deepEqual(
      [r.code, r.suppliers, r.suppliers_new, r.products_supplier_set, r.products_supplier_cleared, r.buyers_removed, r.old_suppliers_deleted, r.old_suppliers_hidden],
      [200, 2, 2, 2, 1, 2, 2, 1]
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(await repo.countRetailPilotSuppliers(), 0);
  });

  it("the switch: RetailPilot suppliers in, products follow, old buyers gone, old suppliers deleted - or hidden where history uses them", async () => {
    const r = await repo.apply(vendors, supplierOf);
    assert.equal(r.code, 200);
    const [masters, products, buyers] = await snapshot();
    assert.deepEqual(masters.map((m) => [m.cid, m.mdm_tag]), [["C11", "old"], ["RP10001", "a"], ["RP10002", "a"]]);
    assert.equal(masters.find((m) => m.cid === "RP10001").mdm_dist_code, RP_CODE_BASE + 10001);
    assert.deepEqual(products.map((p) => [p.product_id, p.distributor_id]), [[1, "RP10001"], [2, "RP10002"], [3, null], [4, null]]);
    assert.deepEqual(buyers, [], "start fresh: no buyer carried over");
    assert.deepEqual((await q("SELECT distributor_code FROM lr_followup")).map((x) => x.distributor_code), [11], "history untouched");
    assert.equal(await repo.countRetailPilotSuppliers(), 2);
  });

  it("the next day keeps buyers and holding days set since, and follows RetailPilot's changes", async () => {
    await q("UPDATE product_distributor_master SET holding_days = 9 WHERE cid = 'RP10001'");
    await q(`INSERT INTO product_distributor (mdm_dist_code, cid, buyer_id) VALUES (?, 'RP10001', 601)`, [String(RP_CODE_BASE + 10001)]);
    const renamed = supplierRows([
      { id: "10001", name: "akshaya agencies pvt ltd", trade_name: "akshaya agencies", is_active: true },
      { id: "10002", name: "metro home need", trade_name: "metro home need (toys)", is_active: false },
    ]).rows;
    const r = await repo.apply(renamed, new Map([["51156", "RP10001"], ["42953", "RP10001"]]));
    assert.equal(r.code, 200);
    const [masters, products, buyers] = await snapshot();
    const a = masters.find((m) => m.cid === "RP10001");
    assert.equal(a.holding_days, 9);
    assert.deepEqual(buyers.map((b) => [b.cid, b.buyer_id]), [["RP10001", 601]]);
    assert.equal(masters.find((m) => m.cid === "RP10002").mdm_tag, "i", "inactive in RetailPilot");
    assert.equal(products.find((p) => p.product_id === 2).distributor_id, "RP10001");
    assert.equal((await q("SELECT mdm_dist_name FROM product_distributor_master WHERE cid = 'RP10001'"))[0].mdm_dist_name, "akshaya agencies");
  });

  it("an empty or shrunken pull changes nothing", async () => {
    const before = await snapshot();
    assert.equal((await repo.apply([], new Map())).code, 409);
    assert.deepEqual(await snapshot(), before);
  });
});
