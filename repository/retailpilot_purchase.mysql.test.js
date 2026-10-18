/**
 * RETAILPILOT PURCHASE SYNC, AS REAL SQL - the three migrations over the
 * deployed purchase schema with GoFrugal history in it, then the real
 * repositories and usecases: import, re-sync, Accounts' corrections,
 * approval, the Tally export, Tally responses and their deletion.
 *
 *   RP_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/retailpilot_purchase.mysql.test.js
 *
 * SKIPPED unless `RP_TEST_MYSQL` names a SCRATCH database: the suite drops
 * and creates its tables. BASE_SCHEMA is `SHOW CREATE TABLE` of the
 * deployed tables (main-autodeploy ac1119d) on MySQL 5.7; the migration
 * FILES are run on top, so what is tested is what production runs. The
 * pool is opened as drivers/mysql.js opens it (bigNumberStrings).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.RP_TEST_MYSQL;

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const sqlFile = (name) => fs.readFileSync(path.join(SQLS, name), "utf8");
const MIGRATIONS = [
  "20261204120000-purchase-retailpilot-columns",
  "20261205120000-purchase-retailpilot-source",
  "20261205130000-retailpilot-purchase-sync-permission",
];

const BASE_SCHEMA = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS purchase, purchase_internal, purchase_tally_response, gst_tally_purchase,
    gst_tally_purchase_internal, outlets, all_permissions, permissions;
  SET FOREIGN_KEY_CHECKS = 1;
  CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(100), retailpilot_id VARCHAR(50) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  CREATE TABLE purchase (
    purchase_id bigint(20) NOT NULL AUTO_INCREMENT,
    retail_outlet_id int(11) DEFAULT NULL,
    supplier_id varchar(20) DEFAULT NULL,
    supplier_name varchar(100) DEFAULT NULL,
    supplier_gstn varchar(20) DEFAULT NULL,
    mmh_mrc_no int(11) DEFAULT NULL,
    mmh_mrc_dt date DEFAULT NULL,
    mmh_mrc_amt decimal(10,2) DEFAULT NULL,
    mmh_dist_bill_dt date DEFAULT NULL,
    mmh_dist_bill_no varchar(50) DEFAULT NULL,
    mmh_mrc_refno varchar(20) DEFAULT NULL,
    mmh_manual_disc decimal(10,2) DEFAULT NULL,
    tot_sgst_amt decimal(10,2) DEFAULT NULL,
    tot_cgst_amt decimal(10,2) DEFAULT NULL,
    tot_igst_amt decimal(10,2) DEFAULT NULL,
    tot_gst_cess_amt decimal(10,2) DEFAULT NULL,
    mmd_goods_tcs_amt decimal(10,2) DEFAULT NULL,
    ts bigint(20) DEFAULT NULL,
    sgst json DEFAULT NULL,
    cgst json DEFAULT NULL,
    igst json DEFAULT NULL,
    cess json DEFAULT NULL,
    has_updated tinyint(1) NOT NULL DEFAULT '0',
    is_approved tinyint(1) NOT NULL DEFAULT '0',
    is_new tinyint(1) NOT NULL DEFAULT '1',
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (purchase_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  CREATE TABLE purchase_internal (
    purchase_id bigint(20) NOT NULL,
    cash_discount decimal(10,2) DEFAULT NULL,
    scheme_difference decimal(10,2) DEFAULT NULL,
    cost_difference decimal(10,2) DEFAULT NULL,
    due decimal(10,2) DEFAULT NULL,
    freight_charges decimal(10,2) DEFAULT NULL,
    round_off decimal(10,2) DEFAULT '0.00',
    jv_ledger int(11) DEFAULT NULL,
    narration text,
    supplier_credit_note decimal(10,2) NOT NULL,
    total_amount decimal(10,2) NOT NULL,
    invoice_amount decimal(10,2) NOT NULL,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (purchase_id),
    CONSTRAINT purchase_internal_ibfk_1 FOREIGN KEY (purchase_id) REFERENCES purchase (purchase_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  CREATE TABLE purchase_tally_response (
    MasterID varchar(200) NOT NULL,
    purchase_id bigint(20) NOT NULL,
    VoucherNo varchar(100) NOT NULL,
    InvoiceValue float NOT NULL,
    SupplierName text NOT NULL,
    CostCentre varchar(100) CHARACTER SET utf8mb4 NOT NULL,
    GSTIN varchar(50) NOT NULL,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (purchase_id),
    UNIQUE KEY uq_purchase_tally_response_master_id (MasterID),
    CONSTRAINT fk_purchase_tally_response_purchase FOREIGN KEY (purchase_id) REFERENCES purchase (purchase_id) ON DELETE CASCADE ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  CREATE TABLE gst_tally_purchase (
    gst_tally_purchase_id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
    master_id varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    source enum('tally','system') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'tally',
    retail_outlet_id int(11) DEFAULT NULL,
    supplier_id varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    supplier_name varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    supplier_gstn varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    mmh_mrc_no int(11) DEFAULT NULL,
    mmh_mrc_dt date DEFAULT NULL,
    mmh_mrc_amt decimal(10,2) DEFAULT NULL,
    mmh_dist_bill_dt date DEFAULT NULL,
    mmh_dist_bill_no varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    mmh_mrc_refno varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
    mmh_manual_disc decimal(10,2) DEFAULT NULL,
    tot_sgst_amt decimal(10,2) DEFAULT NULL,
    tot_cgst_amt decimal(10,2) DEFAULT NULL,
    tot_igst_amt decimal(10,2) DEFAULT NULL,
    tot_gst_cess_amt decimal(10,2) DEFAULT NULL,
    mmd_goods_tcs_amt decimal(10,2) DEFAULT NULL,
    ts bigint(20) DEFAULT NULL,
    sgst json DEFAULT NULL,
    cgst json DEFAULT NULL,
    igst json DEFAULT NULL,
    cess json DEFAULT NULL,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (gst_tally_purchase_id),
    UNIQUE KEY uq_gst_tally_purchase_master_id (master_id),
    KEY idx_gst_tally_purchase_refno (mmh_mrc_refno)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  CREATE TABLE gst_tally_purchase_internal (
    gst_tally_purchase_id bigint(20) unsigned NOT NULL,
    cash_discount decimal(10,2) NOT NULL DEFAULT 0, scheme_difference decimal(10,2) NOT NULL DEFAULT 0,
    cost_difference decimal(10,2) NOT NULL DEFAULT 0, due decimal(10,2) NOT NULL DEFAULT 0,
    freight_charges decimal(10,2) NOT NULL DEFAULT 0, round_off decimal(10,2) NOT NULL DEFAULT 0,
    jv_ledger int(11) DEFAULT NULL, narration text, supplier_credit_note decimal(10,2) NOT NULL DEFAULT 0,
    total_amount decimal(10,2) NOT NULL DEFAULT 0, invoice_amount decimal(10,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (gst_tally_purchase_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  CREATE TABLE all_permissions (permission_id int(11) NOT NULL AUTO_INCREMENT, permission_key varchar(45) DEFAULT NULL, status tinyint(4) DEFAULT '1', PRIMARY KEY (permission_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8;
  CREATE TABLE permissions (permission_key varchar(100) NOT NULL, designation_id int(11) NOT NULL, is_active tinyint(1) NOT NULL DEFAULT '1', created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`;

// Production names (CostCentre in Tally responses is the outlet name).
const OUTLETS = `
  INSERT INTO outlets VALUES
    (2, '\\tDaily Needs-Warehouse', '9rJMC'), (3, 'Daily Needs-Kathirkamam', 'huABy'),
    (4, 'Daily Needs-Vallalar Salai', 'FuUGY'), (5, 'Daily Needs-Moolakulam', 'sooWy'),
    (6, 'Daily Needs-Muthialpet', 'rnMT1'), (7, 'Daily Needs-ECR', 'kKFom');
`;

const L5 = '[{"PERC":2.5,"TAXABLE":500,"VALUE":12.5}]';
// GoFrugal history, in the deployed column types.
const HISTORY = `
  INSERT INTO purchase (purchase_id, retail_outlet_id, supplier_id, supplier_name, supplier_gstn, mmh_mrc_no, mmh_mrc_dt, mmh_mrc_amt,
    mmh_dist_bill_dt, mmh_dist_bill_no, mmh_mrc_refno, mmh_manual_disc, tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
    mmd_goods_tcs_amt, ts, sgst, cgst, igst, cess, is_approved, is_new) VALUES
  (101, 2, '12345678901234567890', 'Old Supplier FY25', '34AAAAA0000A1Z5', 118000, '2025-07-01', 1050.00, '2025-06-30', 'B-1', '6372', 0, 25, 25, 0, 0, 0, 1,
     '[{"PERC":2.5,"TAXABLE":1000,"VALUE":25}]', '[{"PERC":2.5,"TAXABLE":1000,"VALUE":25}]', '[]', '[]', 1, 0),
  (102, 2, '501', 'Last GoFrugal bill', '33BBBBB0000B1Z5', 122486, '2026-10-10', 2360.00, '2026-10-09', 'B-2', '6371', 0, 0, 0, 360, 0, 0, 2,
     '[]', '[]', '[{"PERC":18,"TAXABLE":2000,"VALUE":360}]', '[]', 1, 1),
  (103, 4, '777', 'DN1 pending', '34CCCCC0000C1Z5', 122500, '2026-10-09', 525.00, '2026-10-08', 'B-3', '951', 0, 12.5, 12.5, 0, 0, 0, 3, '${L5}', '${L5}', '[]', '[]', 0, 1),
  (104, 3, '778', 'DN2 same refno', '34CCCCC0000C1Z5', 122501, '2026-10-09', 525.00, '2026-10-08', 'B-4', '951', 0, 12.5, 12.5, 0, 0, 0, 4, '${L5}', '${L5}', '[]', '[]', 1, 1),
  (105, 4, '779', 'DN1 FY25 same refno+GSTIN', '34CCCCC0000C1Z5', 99000, '2025-05-01', 525.00, '2025-05-01', 'B-5', '951', 0, 12.5, 12.5, 0, 0, 0, 5, '${L5}', '${L5}', '[]', '[]', 1, 0),
  (106, 3, '780', 'DN2 FY25 refno 533', '34DDDDD0000D1Z5', 98000, '2025-05-02', 525.00, '2025-05-02', 'B-6', '533', 0, 12.5, 12.5, 0, 0, 0, 6, '${L5}', '${L5}', '[]', '[]', 1, 0),
  (107, 4, '781', 'DN1 FY25 refno 952', '34FFFFF0000F1Z5', 97000, '2026-01-10', 525.00, '2026-01-10', 'B-7', '952', 0, 12.5, 12.5, 0, 0, 0, 7, '${L5}', '${L5}', '[]', '[]', 1, 0);
  INSERT INTO purchase_internal (purchase_id, cash_discount, scheme_difference, cost_difference, due, freight_charges, round_off, jv_ledger, narration, supplier_credit_note, total_amount, invoice_amount) VALUES
    (101,0,0,0,0,0,0,1,'',0,1050,1050), (102,0,0,0,0,0,0,1,'',0,2360,2360), (104,0,0,0,0,0,0,1,'',0,525,525), (105,0,0,0,0,0,0,1,'',0,525,525);
  INSERT INTO purchase_tally_response (MasterID, purchase_id, VoucherNo, InvoiceValue, SupplierName, CostCentre, GSTIN) VALUES
    ('101-purchase-entry', 101, '6372', 1050, 'Old Supplier FY25', '\\tDaily Needs-Warehouse', '34AAAAA0000A1Z5'),
    ('104-purchase-entry', 104, '951', 525, 'DN2 same refno', 'Daily Needs-Kathirkamam', '34CCCCC0000C1Z5'),
    ('105-purchase-entry', 105, '951', 525, 'DN1 FY25', 'Daily Needs-Vallalar Salai', '34CCCCC0000C1Z5');
  INSERT INTO gst_tally_purchase (master_id, source, retail_outlet_id, supplier_id, supplier_name, supplier_gstn, mmh_mrc_no, mmh_mrc_dt, mmh_mrc_amt,
    mmh_dist_bill_dt, mmh_dist_bill_no, mmh_mrc_refno, ts, sgst, cgst, igst, cess) VALUES
    ('101-purchase-entry', 'system', 2, '12345678901234567890', 'Old Supplier FY25', '34AAAAA0000A1Z5', 118000, '2025-07-01', 1050, '2025-06-30', 'B-1', '6372', 1,
     '[{"PERC":2.5,"TAXABLE":1000,"VALUE":25}]', '[{"PERC":2.5,"TAXABLE":1000,"VALUE":25}]', '[]', '[]');
`;

const FINGERPRINT = `
  SELECT purchase_id, retail_outlet_id, supplier_id, CAST(mmh_mrc_no AS CHAR) AS mrc_no, mmh_mrc_refno,
         DATE_FORMAT(mmh_mrc_dt, '%Y-%m-%d') AS dt, mmh_mrc_amt, is_approved, CAST(sgst AS CHAR) s, CAST(igst AS CHAR) i
  FROM purchase WHERE purchase_id BETWEEN 101 AND 107 ORDER BY purchase_id`;

/** A RetailPilot SPECTRA row (one per invoice per tax-rate set). */
const rpRow = (over = {}) => ({
  invoice_slug: "INV-A",
  supplier_invoice_id: "SUP-1",
  mrc_no: 6372,
  store_id: "9rJMC",
  supplier_id: "VEND-1",
  supplier_name: "A Supplier",
  supplier_gstn: "34AAAAA0000A1Z5",
  received_date: "2026-10-16",
  invoice_date: "2026-10-15",
  fy: 2026,
  entered_at: "2026-10-16T12:00:00+05:30",
  invoice_amount: "1050.40",
  tcs: "0",
  cgst_rate: "2.5",
  sgst_rate: "2.5",
  igst_rate: "0",
  cess_rate: "0",
  taxable: "1000",
  ...over,
});

const ROWS = {
  // ordinary bill, +0.40 round-off
  a: rpRow(),
  // Warehouse MRC 6392: k.r.candles, no GSTIN, IGST 5%
  krc: rpRow({ invoice_slug: "INV-KRC", mrc_no: 6392, supplier_name: "k.r.candles", supplier_gstn: "", cgst_rate: "0", sgst_rate: "0", igst_rate: "5", taxable: "4271.43", invoice_amount: "4485.00" }),
  // DN1 bill 271 as RetailPilot holds it: no received date, invoice date
  // 16-01-2026 (so the query's received_date is that too), entered
  // 16-10-2026 with a seq of the FY 2026-27 series. 952 is also last
  // year's DN1 bill 107 (dated 10-01-2026).
  dn1: rpRow({ invoice_slug: "INV-ouL0uNb0VjxP", store_id: "FuUGY", mrc_no: 952, supplier_name: "fresh home food", supplier_gstn: "34EEEEE0000E1Z5", supplier_invoice_id: "271", received_date: "2026-01-16", invoice_date: "2026-01-16", entered_at: "2026-10-16T16:09:20+05:30", invoice_amount: "1050.00" }),
  // large negative difference (credit taken off the bill)
  neg: rpRow({ invoice_slug: "INV-NEG", mrc_no: 6373, invoice_amount: "749.80" }),
  // zero difference
  zero: rpRow({ invoice_slug: "INV-ZERO", mrc_no: 6374, invoice_amount: "1050.00" }),
  // DN2 FY 2026-27 seq 533 (533 was used at DN2 in FY 2025-26 too)
  dn2: rpRow({ invoice_slug: "INV-DN2", store_id: "huABy", mrc_no: 533, supplier_gstn: "34DDDDD0000D1Z5", invoice_amount: "1050.00" }),
  // seq 6371 is GoFrugal's last Warehouse bill this year: a real clash
  clash: rpRow({ invoice_slug: "INV-CLASH", mrc_no: 6371 }),
  // a store no branch carries
  unknown: rpRow({ invoice_slug: "INV-UNKNOWN", store_id: "zzNew", mrc_no: 1 }),
};

describe("RetailPilot purchase sync, as SQL", { skip: !URL && "RP_TEST_MYSQL is not set" }, () => {
  let pool;
  let admin;
  let q;
  let a; // app pieces
  let spectraRows;

  const run = (opts) => a.sync.run(opts);
  const byslug = async (slug) => (await q("SELECT * FROM purchase WHERE mmh_mrc_no = ?", [slug]))[0];
  const internal = async (id) => (await q("SELECT * FROM purchase_internal WHERE purchase_id = ?", [id]))[0];
  const setRows = (...rows) => {
    spectraRows = rows;
  };

  // What the Purchase screen sends on Save (components/Purchase/PurchaseModal).
  const screenSave = async (id, edit = {}, internalEdit = {}) => {
    const p = (await a.purchaseRepo.getById(id)).data;
    const purchase = {
      purchase_id: id,
      retail_outlet_id: p.retail_outlet_id,
      supplier_id: p.supplier_id,
      supplier_name: p.supplier_name || "x",
      supplier_gstn: p.supplier_gstn,
      mmh_mrc_no: p.mmh_mrc_no,
      mmh_mrc_dt: p.mmh_mrc_dt,
      mmh_mrc_amt: p.mmh_mrc_amt,
      mmh_dist_bill_dt: p.mmh_dist_bill_dt,
      mmh_dist_bill_no: p.mmh_dist_bill_no,
      mmh_mrc_refno: p.mmh_mrc_refno,
      mmh_manual_disc: p.mmh_manual_disc,
      tot_sgst_amt: p.tot_sgst_amt,
      tot_cgst_amt: p.tot_cgst_amt,
      tot_igst_amt: p.tot_igst_amt,
      tot_gst_cess_amt: p.tot_gst_cess_amt,
      mmd_goods_tcs_amt: p.mmd_goods_tcs_amt,
      ts: p.ts,
      sgst: p.sgst,
      cgst: p.cgst,
      igst: p.igst,
      cess: p.cess,
      ...edit,
    };
    const purchaseInternal = {
      cash_discount: 0, scheme_difference: 0, cost_difference: 0, due: 0, freight_charges: 0,
      round_off: p.round_off, jv_ledger: 1, narration: "", supplier_credit_note: 0,
      total_amount: p.total_amount, invoice_amount: p.mmh_mrc_amt,
      ...internalEdit,
    };
    return a.purchaseUsecase.updatePurchaseWithInternal(purchase, purchaseInternal, false);
  };
  const approve = (id) => a.purchaseUsecase.updatePurchaseFlags(id, { is_approved: true, has_updated: false });
  const unlock = (id) => a.purchaseUsecase.updatePurchaseFlags(id, { is_approved: false, has_updated: false });

  before(async () => {
    const mysql = require("mysql");
    admin = mysql.createConnection(`${URL}${URL.includes("?") ? "&" : "?"}multipleStatements=true`);
    q = (sql, params = []) => new Promise((resolve, reject) => admin.query(sql, params, (err, res) => (err ? reject(err) : resolve(res))));
    await q("SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'");
    await q(BASE_SCHEMA);
    await q(OUTLETS);
    await q(HISTORY);
    a = {};
    a.historyBefore = await q(FINGERPRINT);
    for (const m of MIGRATIONS) await q(sqlFile(`${m}-up.sql`));

    // The pool the app gets (drivers/mysql.js).
    pool = mysql.createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=4&supportBigNumbers=true&bigNumberStrings=true`);
    a.purchaseRepo = require("./purchase")(pool);
    a.outletUsecase = { getOutletById: async () => [], getRetailPilotStoreMap: async () => {
      const rows = await q("SELECT outlet_id, retailpilot_id FROM outlets WHERE retailpilot_id IS NOT NULL");
      return Object.fromEntries(rows.map((r) => [r.retailpilot_id, r.outlet_id]));
    } };
    a.purchaseUsecase = require("../usecase/purchase")(a.purchaseRepo, a.outletUsecase);
    a.sync = require("../usecase/retailpilot_purchase_sync")(
      { isConfigured: () => true, queryAll: async () => spectraRows },
      a.purchaseUsecase,
      { purchaseLookbackDays: 3 },
      () => a.outletUsecase.getRetailPilotStoreMap()
    );
    a.tallyRepo = require("./purchase_tally")(pool);
    a.tallyUsecase = require("../usecase/purchase_tally")(a.tallyRepo, null);
    a.tallyExport = require("../usecase/tally")(null, a.purchaseUsecase, null, null);
  });

  after(async () => {
    if (pool) await new Promise((r) => pool.end(r));
    if (admin) admin.end();
  });

  // --------------------------------------------------------------- migrations
  it("the migrations keep every GoFrugal row as it was, and widen the columns", async () => {
    assert.deepEqual(await q(FINGERPRINT), a.historyBefore);
    const cols = await q(
      `SELECT table_name t, column_name c, column_type ty, is_nullable n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name IN ('purchase','gst_tally_purchase')
         AND column_name IN ('mmh_mrc_no','mmh_mrc_refno','supplier_id','retailpilot_source') ORDER BY t, c`
    );
    assert.deepEqual(cols.map((r) => `${r.t || r.TABLE_NAME}.${r.c || r.COLUMN_NAME}=${r.ty || r.COLUMN_TYPE}/${r.n || r.IS_NULLABLE}`), [
      "gst_tally_purchase.mmh_mrc_no=varchar(50)/YES",
      "gst_tally_purchase.mmh_mrc_refno=varchar(50)/NO",
      "gst_tally_purchase.supplier_id=varchar(50)/YES",
      "purchase.mmh_mrc_no=varchar(50)/YES",
      "purchase.mmh_mrc_refno=varchar(50)/YES",
      "purchase.retailpilot_source=text/YES",
      "purchase.supplier_id=varchar(50)/YES",
    ]);
    const keys = await q("SELECT permission_key FROM all_permissions WHERE permission_key = 'sync_retailpilot_purchases'");
    assert.equal(keys.length, 1);
    assert.equal((await q("SELECT COUNT(*) n FROM permissions"))[0].n, 0, "granted to nobody");
  });

  // ---------------------------------------------------------- initial import
  it("initial import: new bills inserted with the full round-off; clash and unknown branch skipped", async () => {
    setRows(ROWS.a, ROWS.krc, ROWS.dn1, ROWS.neg, ROWS.zero, ROWS.dn2, ROWS.clash, ROWS.unknown);
    const r = await run();
    assert.equal(r.code, 200);
    assert.deepEqual([r.inserted, r.updated, r.unchanged, r.approved_untouched], [6, 0, 0, 0]);
    assert.deepEqual(r.skipped.map((s) => s.invoice_slug).sort(), ["INV-CLASH", "INV-UNKNOWN"]);
    assert.deepEqual(
      r.discrepancies.map((d) => `${d.invoice_slug}:${d.code}`).sort(),
      ["INV-KRC:TAX_TYPE_MISMATCH", "INV-ouL0uNb0VjxP:MRC_DATE_OUTSIDE_SERIES_FY"]
    );
    assert.ok(await byslug("INV-ouL0uNb0VjxP"), "bill 271 imported, not skipped against last year's DN1 952");

    const roundOff = {};
    for (const slug of ["INV-A", "INV-KRC", "INV-NEG", "INV-ZERO"]) {
      const p = await byslug(slug);
      const i = await internal(p.purchase_id);
      roundOff[slug] = [Number(i.round_off), Number(i.total_amount)];
      assert.ok(p.retailpilot_source, "the sync's values are kept for later merges");
    }
    assert.deepEqual(roundOff, {
      "INV-A": [0.4, 1050.4],
      "INV-KRC": [4485, 4485], // nothing hidden: approval is what is blocked
      "INV-NEG": [-300.2, 749.8],
      "INV-ZERO": [0, 1050],
    });
    const krc = await byslug("INV-KRC");
    assert.equal(krc.mmh_mrc_refno, "6392");
    assert.equal(krc.retail_outlet_id, 2);
    assert.deepEqual(await q(FINGERPRINT), a.historyBefore, "GoFrugal history untouched (6372 of FY 2025-26 included)");
  });

  it("repeated import: nothing written", async () => {
    const before = await q("SELECT purchase_id, updated_at, ts FROM purchase ORDER BY purchase_id");
    const r = await run();
    assert.deepEqual([r.inserted, r.updated, r.unchanged], [0, 0, 6]);
    assert.deepEqual(await q("SELECT purchase_id, updated_at, ts FROM purchase ORDER BY purchase_id"), before);
  });

  // ----------------------------------------------------------- round-off
  it("RetailPilot changes an untouched bill: values and the sync's own round-off follow", async () => {
    setRows({ ...ROWS.a, invoice_amount: "1051.00" });
    const r = await run();
    assert.equal(r.updated, 1);
    const p = await byslug("INV-A");
    assert.equal(Number(p.mmh_mrc_amt), 1051);
    assert.deepEqual([Number((await internal(p.purchase_id)).round_off)], [1]);
  });

  it("manual override: Accounts' round-off is never overwritten by a later sync", async () => {
    const p = await byslug("INV-A");
    assert.equal((await screenSave(p.purchase_id, {}, { round_off: 0.75, total_amount: 1050.75 })).code, 200);
    setRows({ ...ROWS.a, invoice_amount: "1052.00" });
    const r = await run();
    assert.equal(r.updated, 1);
    const after = await byslug("INV-A");
    assert.equal(Number(after.mmh_mrc_amt), 1052, "the bill amount still follows RetailPilot");
    assert.equal(Number((await internal(p.purchase_id)).round_off), 0.75, "Accounts' round-off stays");
  });

  // ------------------------------------------------- Accounts' corrections
  it("k.r.candles: approval is refused until the GST discrepancy is corrected", async () => {
    const p = await byslug("INV-KRC");
    const refused = await approve(p.purchase_id);
    assert.equal(refused.code, 409);
    assert.match(refused.msg, /IGST charged .* has no GSTIN/);
    assert.equal((await byslug("INV-KRC")).is_approved, 0);
  });

  it("Accounts correct the GSTIN and the round-off on the Purchase screen; the flag clears and approval goes through", async () => {
    const p = await byslug("INV-KRC");
    const saved = await screenSave(p.purchase_id, { supplier_gstn: "33KRCAN0000K1Z5" }, { round_off: 0, total_amount: 4485 });
    assert.equal(saved.code, 200);
    const now = (await a.purchaseRepo.getById(p.purchase_id)).data;
    assert.deepEqual(now.discrepancies, []);
    assert.equal((await approve(p.purchase_id)).code, 200);
  });

  it("Tally export of the corrected bill: voucher number, branch voucher type, dates, IGST ledgers and total", async () => {
    const out = (await a.tallyExport.getPurchase("10-01-2026", "10-31-2026")).data;
    const v = out.find((e) => e.VoucherNumber === "6392" && /purchase-entry/.test(e.MasterID));
    assert.ok(v, "the approved bill is exported");
    assert.equal(v.BuyerGSTIN, "33KRCAN0000K1Z5");
    assert.equal(v.VoucherType, "Purchase", "Warehouse voucher type");
    assert.equal(v.VoucherDate, "20261016");
    assert.equal(Number(v.Voucher_Total), 4485);
    const ledgers = v.ledgerentries.map((l) => l.LedgerName);
    assert.ok(ledgers.includes("IGST PURCHASE 5%"), ledgers.join(", "));
    assert.ok(!ledgers.some((n) => /CGST|SGST/.test(n)));
    assert.ok(!out.some((e) => e.VoucherNumber === "6372" && e.BuyerGSTIN === "34AAAAA0000A1Z5" && /101-/.test(e.MasterID)), "pushed GoFrugal bill not re-exported");
  });

  it("an approved bill is frozen: a RetailPilot change does not touch it", async () => {
    const before = await byslug("INV-KRC");
    setRows({ ...ROWS.krc, invoice_amount: "4500.00" });
    const r = await run();
    assert.equal(r.approved_untouched, 1);
    const after = await byslug("INV-KRC");
    assert.deepEqual(after, before);
  });

  it("unlocked again, a re-sync keeps the corrected GSTIN, applies the rest, and flags a tax change it did not apply", async () => {
    const p = await byslug("INV-KRC");
    await unlock(p.purchase_id);
    setRows({ ...ROWS.krc, invoice_amount: "4500.00" });
    let r = await run();
    assert.equal(r.updated, 1);
    let now = await byslug("INV-KRC");
    assert.equal(now.supplier_gstn, "33KRCAN0000K1Z5", "Accounts' GSTIN kept");
    assert.equal(Number(now.mmh_mrc_amt), 4500, "RetailPilot's new amount applied");
    assert.equal(Number((await internal(p.purchase_id)).round_off), 0, "Accounts saved the round-off: kept");

    // Accounts re-enter the tax; RetailPilot then changes its tax too.
    await screenSave(p.purchase_id, {
      igst: [{ PERC: 5, TAXABLE: 4285.71, VALUE: "214.29" }], tot_igst_amt: 214.29,
    }, { round_off: 0, total_amount: 4500 });
    setRows({ ...ROWS.krc, invoice_amount: "4500.00", taxable: "4290.00" });
    r = await run();
    assert.deepEqual(r.corrections_kept.map((c) => [c.invoice_slug, c.fields]), [["INV-KRC", ["tax"]]]);
    now = await byslug("INV-KRC");
    assert.equal(JSON.parse(now.igst)[0].TAXABLE, 4285.71, "Accounts' tax kept");
    const shown = (await a.purchaseRepo.getById(p.purchase_id)).data.discrepancies;
    assert.deepEqual(shown.map((d) => d.code), ["RETAILPILOT_CHANGE_NOT_APPLIED"]);
    assert.match(shown[0].message, /changed the tax after Accounts corrected it/);
  });

  it("DN1 bill 271: approval refused while the MRC date is outside its ref no's year; Accounts correct both dates", async () => {
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const p = await byslug("INV-ouL0uNb0VjxP");
    const shown = (await a.purchaseRepo.getById(p.purchase_id)).data;
    assert.deepEqual(shown.discrepancies.map((d) => `${d.code}:${d.severity}`), ["MRC_DATE_OUTSIDE_SERIES_FY:block"]);
    assert.equal(shown.voucher_fy, 2026, "the screen gets the series year for its live check");
    assert.equal(shown.entered_at, "2026-10-16");
    const refused = await approve(p.purchase_id);
    assert.equal(refused.code, 409);
    assert.match(refused.msg, /MRC date 2026-01-16 is in FY 2025-26, but MRC ref no 952 is numbered in the FY 2026-27 series/);

    // MRC date to the entry date: re-validated against FY 2026-27 (952 is
    // free there - 107 is FY 2025-26), the supplier bill date left for review.
    assert.equal((await screenSave(p.purchase_id, { mmh_mrc_dt: "2026-10-16" })).code, 200);
    assert.deepEqual((await a.purchaseRepo.getById(p.purchase_id)).data.discrepancies.map((d) => d.code), ["BILL_DATE_OTHER_FY"]);
    assert.equal((await screenSave(p.purchase_id, { mmh_dist_bill_dt: "2026-10-15" })).code, 200);
    assert.deepEqual((await a.purchaseRepo.getById(p.purchase_id)).data.discrepancies, []);

    setRows({ ...ROWS.dn1, invoice_amount: "1060.00" });
    await run();
    const now = await byslug("INV-ouL0uNb0VjxP");
    assert.equal(Number(now.mmh_mrc_amt), 1060, "RetailPilot's amount change applied");
    assert.equal(day(now.mmh_mrc_dt), "2026-10-16", "Accounts' MRC date kept");
    assert.equal(day(now.mmh_dist_bill_dt), "2026-10-15", "Accounts' bill date kept");
    assert.equal((await approve(p.purchase_id)).code, 200);

    const out = (await a.tallyExport.getPurchase("10-01-2026", "10-31-2026")).data;
    const v = out.find((e) => e.VoucherNumber === "952" && /purchase-entry/.test(e.MasterID) && e.VoucherType === "PurchaseDN1");
    assert.ok(v, "exported with DN1's voucher type");
    assert.equal(v.VoucherDate, "20261016", "Tally gets the corrected voucher date");
    assert.equal(v.Reference, "271");
    assert.deepEqual(await q(FINGERPRINT), a.historyBefore, "last year's DN1 952 untouched");
  });

  it("moving a bill's MRC date into a year where its ref no is taken is refused; the date does not change matching", async () => {
    const p = await byslug("INV-DN2");
    const refused = await screenSave(p.purchase_id, { mmh_mrc_dt: "2025-05-03" });
    assert.equal(refused.code, 409);
    assert.match(refused.msg, /533 is already used by purchase 106/);
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    assert.equal(day((await byslug("INV-DN2")).mmh_mrc_dt), "2026-10-16", "nothing written");

    // RetailPilot re-dates the bill: still the same row (matched by slug), and
    // the FY 2025-26 bill 106 with ref 533 is untouched.
    setRows({ ...ROWS.dn2, received_date: "2026-10-01" });
    const r = await run();
    assert.equal(r.updated, 1);
    assert.equal((await q("SELECT COUNT(*) n FROM purchase WHERE mmh_mrc_no = 'INV-DN2'"))[0].n, 1);
    assert.deepEqual(await q(FINGERPRINT), a.historyBefore);
  });

  // ------------------------------------------------------------------ Tally
  it("a Tally response is linked by the MasterID the export sent, not by voucher number alone", async () => {
    // DN1 951: pending 103 (FY 26-27) and pushed 105 (FY 25-26), same GSTIN.
    assert.equal((await approve(103)).code, 200);
    const r = await a.tallyUsecase.create({
      MasterID: "103-purchase-entry", VoucherNo: "951", InvoiceValue: 525, SupplierName: "DN1 pending",
      CostCentre: "Daily Needs-Vallalar Salai", GSTIN: "34CCCCC0000C1Z5",
    });
    assert.equal(r.code, 200);
    assert.equal(String(r.purchase_id), "103");
    const resp = await q("SELECT purchase_id, MasterID FROM purchase_tally_response WHERE VoucherNo = '951' ORDER BY purchase_id");
    assert.deepEqual(resp.map((x) => `${x.purchase_id}:${x.MasterID}`), ["103:103-purchase-entry", "104:104-purchase-entry", "105:105-purchase-entry"]);
  });

  it("without a usable MasterID it narrows to the approved bill with no response; two such bills are refused", async () => {
    await q("DELETE FROM purchase_tally_response WHERE purchase_id = 103");
    const one = await a.tallyRepo.resolvePurchaseForTallyResponse({
      MasterID: "TALLY-OWN-ID", VoucherNo: "951", CostCentre: "Daily Needs-Vallalar Salai", GSTIN: "34CCCCC0000C1Z5",
    });
    assert.equal(String(one.purchaseId), "103", "105 (other year) already has its response");

    await q("DELETE FROM purchase_tally_response WHERE purchase_id = 105");
    const two = await a.tallyUsecase.create({
      MasterID: "TALLY-OWN-ID", VoucherNo: "951", InvoiceValue: 525, SupplierName: "x",
      CostCentre: "Daily Needs-Vallalar Salai", GSTIN: "34CCCCC0000C1Z5",
    });
    assert.equal(two.code, 409, "the old code linked the newest one silently");
    assert.equal((await q("SELECT COUNT(*) n FROM purchase_tally_response WHERE purchase_id IN (103,105)"))[0].n, 0);
    // restore 105 for the delete tests
    await q("INSERT INTO purchase_tally_response (MasterID, purchase_id, VoucherNo, InvoiceValue, SupplierName, CostCentre, GSTIN) VALUES ('105-purchase-entry',105,'951',525,'DN1 FY25','Daily Needs-Vallalar Salai','34CCCCC0000C1Z5')");
  });

  it("deleting by voucher number refuses when the number spans branches or years; by purchase id deletes exactly one", async () => {
    const before = await q("SELECT purchase_id FROM purchase_tally_response ORDER BY purchase_id");
    const old = await a.purchaseUsecase.deleteTallyResponse("951");
    assert.equal(old.code, 409);
    assert.deepEqual(await q("SELECT purchase_id FROM purchase_tally_response ORDER BY purchase_id"), before, "nothing deleted");

    const one = await a.purchaseUsecase.deleteTallyResponseForPurchase(104);
    assert.equal(one.code, 200);
    const left = (await q("SELECT purchase_id FROM purchase_tally_response ORDER BY purchase_id")).map((r) => String(r.purchase_id));
    assert.deepEqual(left, before.map((r) => String(r.purchase_id)).filter((id) => id !== "104"));
    assert.equal((await a.purchaseUsecase.deleteTallyResponseForPurchase(104)).code, 404);

    const unique = await a.purchaseUsecase.deleteTallyResponse("6372");
    assert.equal(unique.code, 200, "a voucher number on one purchase only still deletes, as before");
    assert.equal((await q("SELECT COUNT(*) n FROM purchase_tally_response WHERE purchase_id = 101"))[0].n, 0);
  });

  // -------------------------------------------------------------- rollback
  it("rolling the column migration back after RetailPilot bills exist is refused by MySQL, and loses nothing", async () => {
    const before = await q("SELECT purchase_id, mmh_mrc_no, mmh_mrc_refno FROM purchase ORDER BY purchase_id");
    await q(sqlFile("20261205120000-purchase-retailpilot-source-down.sql"));
    await assert.rejects(q(sqlFile("20261204120000-purchase-retailpilot-columns-down.sql")), /Incorrect integer value|Truncated|Data truncated/);
    assert.deepEqual(await q("SELECT purchase_id, mmh_mrc_no, mmh_mrc_refno FROM purchase ORDER BY purchase_id"), before);
    const col = await q(`SELECT column_type t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'purchase' AND column_name = 'mmh_mrc_no'`);
    assert.equal(col[0].t || col[0].COLUMN_TYPE, "varchar(50)");
  });
});
