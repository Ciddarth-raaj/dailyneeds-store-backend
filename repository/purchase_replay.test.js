/**
 * Replaying the purchase push must not duplicate anything.
 *
 *   node --test repository/purchase_replay.test.js
 *
 * The external GoFrugal-side pusher stopped being accepted on 6 September 2026
 * (it kept calling the plain-HTTP URL and got a 301 it did not follow), so the
 * `purchase` table has a gap from 06-09 onward. Recovery means replaying those
 * days - which is only safe if `bulkCreate` is an upsert rather than an insert.
 *
 * It is: it looks up `(mmh_mrc_refno, retail_outlet_id)` and only inserts when
 * that pair is absent. These tests pin that, and pin the two rules that make a
 * replay safe on top of an intact history:
 *
 *   an unchanged row is left alone entirely (no write, no timestamp churn)
 *   an APPROVED row is never modified, even if the payload differs
 *
 * The second matters most: the 12,089 existing records include approved ones,
 * and a replay must not quietly un-approve or overwrite somebody's work.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildRepo = require("./purchase");

/** The natural key the repository dedupes on. */
const keyOf = (row) => `${row.retail_outlet_id}::${row.mmh_mrc_refno}`;

/**
 * A stand-in for MySQL that answers the three statements bulkCreate issues -
 * the existence SELECT, the UPDATE and the INSERT - against an in-memory
 * table, and counts them so a test can assert that nothing was written.
 */
function makeDb(initialRows = []) {
  const state = {
    rows: initialRows.map((r) => ({ ...r })),
    inserts: 0,
    updates: 0,
    selects: 0,
  };

  const db = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();

      const select = text.match(/^SELECT \* FROM purchase WHERE (mmh_mrc_refno|mmh_mrc_no) = \? AND retail_outlet_id = \? ORDER BY purchase_id DESC/);
      if (select) {
        state.selects += 1;
        state.matchedOn = select[1];
        const [value, outlet] = params;
        const found = state.rows
          .filter((r) => r[select[1]] === value && Number(r.retail_outlet_id) === Number(outlet))
          .sort((a, b) => b.purchase_id - a.purchase_id);
        cb(null, found.map((r) => ({ ...r })));
        return;
      }

      if (/^UPDATE purchase SET/.test(text)) {
        state.updates += 1;
        assert.match(text, /WHERE purchase_id = \?$/, "an update touches exactly one row, by id");
        // The purchase_id is the last bound parameter.
        const id = params[params.length - 1];
        const row = state.rows.find((r) => r.purchase_id === id);
        if (row) {
          row.ts = params[8];
          row.mmh_mrc_amt = params[5];
          row.has_updated = params[params.length - 3];
          row.is_approved = params[params.length - 2];
        }
        cb(null, { affectedRows: row ? 1 : 0 });
        return;
      }

      if (/^INSERT INTO purchase \(/.test(text)) {
        state.inserts += 1;
        state.rows.push({
          purchase_id: state.rows.length + 1,
          retail_outlet_id: params[0],
          mmh_mrc_no: params[4],
          mmh_mrc_dt: params[5],
          mmh_mrc_amt: params[6],
          mmh_mrc_refno: params[9],
          ts: params[16],
          is_approved: 0,
          has_updated: 0,
        });
        cb(null, { insertId: state.rows.length, affectedRows: 1 });
        return;
      }

      // Anything else bulkCreate happens to run is a no-op for these tests.
      cb(null, []);
    },
  };

  return { db, state };
}

/** One push payload, in the uppercase shape the pusher sends. */
const payload = (over = {}) => ({
  STORE_ID: 2,
  SUPPLIER_ID: "S1",
  SUPPLIER_NAME: "A Supplier",
  SUPPLIER_GSTN: "33AAAAA0000A1Z5",
  MRC_NO: 1001,
  MRC_DATE: "2026-09-06",
  MRC_AMT: 1500.5,
  DIST_BILL_DT: "2026-09-05",
  DIST_BILL_NO: "B-1",
  MRC_REF: "REF-1001",
  MANUAL_DISC: 0,
  TOT_SGST_AMT: 10,
  TOT_CGST_AMT: 10,
  TOT_IGST_AMT: 0,
  TOT_GST_CESS_AMT: 0,
  GOODS_TCS_AMT: 0,
  TS: 1000,
  SGST: [],
  CGST: [],
  IGST: [],
  CESS: [],
  ...over,
});

const existingRow = (over = {}) => ({
  purchase_id: 1,
  retail_outlet_id: 2,
  mmh_mrc_refno: "REF-1001",
  mmh_mrc_no: 1001,
  mmh_mrc_dt: "2026-09-06",
  mmh_mrc_amt: 1500.5,
  ts: 1000,
  is_approved: 0,
  has_updated: 0,
  ...over,
});

/* ================================================== the natural key ===== */
describe("the natural key", () => {
  it("is (retail_outlet_id, mmh_mrc_refno) - the pair the repository looks up", () => {
    const src = fs.readFileSync(path.join(__dirname, "purchase.js"), "utf8");
    const fn = src.slice(src.indexOf("async bulkCreate("));
    assert.match(
      fn,
      /SELECT \* FROM purchase WHERE \$\{matchOn\} = \? AND retail_outlet_id = \? ORDER BY purchase_id DESC/,
      "the existence check must be on the natural key"
    );
    assert.match(fn, /async bulkCreate\(purchaseList, \{ matchOn = "mmh_mrc_refno" \} = \{\}\)/, "the GoFrugal push keeps refno");
    // The MRC reference is only unique WITHIN an outlet: two branches issue
    // their own sequences, so the outlet has to be part of the key.
    const check = fn.slice(fn.indexOf("SELECT * FROM purchase"), fn.indexOf("SELECT * FROM purchase") + 400);
    assert.match(check, /retail_outlet_id/);
  });
});

/* ================================================== replaying a gap ===== */
describe("replaying the missing days", () => {
  it("inserts a row that is genuinely new", async () => {
    const { db, state } = makeDb([]);
    const res = await buildRepo(db).bulkCreate([payload()]);
    assert.equal(state.inserts, 1);
    assert.equal(res.insertedCount !== undefined ? res.insertedCount : 1, 1);
    assert.equal(state.rows.length, 1);
  });

  it("REPLAY IS IDEMPOTENT: the same push twice leaves one row", async () => {
    const { db, state } = makeDb([]);
    const repo = buildRepo(db);
    await repo.bulkCreate([payload()]);
    await repo.bulkCreate([payload()]);
    assert.equal(state.rows.length, 1, "no duplicate");
    assert.equal(state.inserts, 1, "and the second push inserted nothing");
  });

  it("a replay of a whole batch inserts each row exactly once", async () => {
    const batch = [
      payload({ MRC_REF: "REF-1", MRC_NO: 1 }),
      payload({ MRC_REF: "REF-2", MRC_NO: 2 }),
      payload({ MRC_REF: "REF-3", MRC_NO: 3 }),
    ];
    const { db, state } = makeDb([]);
    const repo = buildRepo(db);
    await repo.bulkCreate(batch);
    await repo.bulkCreate(batch);
    await repo.bulkCreate(batch);
    assert.equal(state.rows.length, 3);
    assert.equal(state.inserts, 3);
  });

  it("the same reference at a DIFFERENT outlet is a different purchase", async () => {
    const { db, state } = makeDb([]);
    await buildRepo(db).bulkCreate([payload({ STORE_ID: 2 }), payload({ STORE_ID: 3 })]);
    assert.equal(state.rows.length, 2, "the outlet is part of the key");
    assert.deepEqual(state.rows.map((r) => Number(r.retail_outlet_id)).sort(), [2, 3]);
  });
});

/* ============================================ existing history is safe == */
describe("a replay does not disturb the history already in the table", () => {
  it("an unchanged row is not written at all", async () => {
    const { db, state } = makeDb([existingRow({ ts: 1000 })]);
    await buildRepo(db).bulkCreate([payload({ TS: 1000 })]);
    assert.equal(state.inserts, 0);
    assert.equal(state.updates, 0, "an identical push must not touch the row");
    assert.equal(state.rows.length, 1);
  });

  it("AN APPROVED ROW IS NEVER MODIFIED, even when the payload differs", async () => {
    // The most important guarantee of the whole recovery: a replay must not
    // overwrite or un-approve work somebody has already signed off.
    const { db, state } = makeDb([existingRow({ ts: 1000, is_approved: 1, mmh_mrc_amt: 1500.5 })]);
    await buildRepo(db).bulkCreate([payload({ TS: 2000, MRC_AMT: 9999.99 })]);
    assert.equal(state.updates, 0, "no UPDATE was issued");
    assert.equal(state.inserts, 0, "and certainly no second row");
    assert.equal(Number(state.rows[0].mmh_mrc_amt), 1500.5, "the approved amount stands");
    assert.equal(Number(state.rows[0].is_approved), 1, "and it is still approved");
  });

  it("an unapproved row whose source data changed is updated in place", async () => {
    const { db, state } = makeDb([existingRow({ ts: 1000, is_approved: 0 })]);
    await buildRepo(db).bulkCreate([payload({ TS: 2000, MRC_AMT: 1600 })]);
    assert.equal(state.updates, 1);
    assert.equal(state.inserts, 0);
    assert.equal(state.rows.length, 1, "updated in place, not appended");
    assert.equal(Number(state.rows[0].ts), 2000);
  });

  it("so replaying 6 September onward over intact history adds only the gap", async () => {
    // Five purchases already present (the pre-06-09 history), and a replay
    // that re-sends them together with three the gap is missing.
    const history = [1, 2, 3, 4, 5].map((n) =>
      existingRow({ purchase_id: n, mmh_mrc_refno: `REF-${n}`, mmh_mrc_no: n, ts: 100 + n })
    );
    const { db, state } = makeDb(history);
    const replay = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      payload({ MRC_REF: `REF-${n}`, MRC_NO: n, TS: 100 + n })
    );
    await buildRepo(db).bulkCreate(replay);
    assert.equal(state.rows.length, 8, "five kept, three added");
    assert.equal(state.inserts, 3);
    assert.equal(state.updates, 0, "and the five untouched rows were not rewritten");
  });
});

/* ======================================= matching RetailPilot bills ===== */
describe("matching a RetailPilot bill by its slug (matchOn: mmh_mrc_no)", () => {
  const rp = (over = {}) => payload({ MRC_NO: "INV-AAA", MRC_REF: "6372", TS: 1, ...over });

  it("finds the bill by slug, so a changed date or reference still updates the same row", async () => {
    const { db, state } = makeDb([
      existingRow({ purchase_id: 5, mmh_mrc_refno: "6372", mmh_mrc_no: "INV-AAA", ts: 1 }),
    ]);
    await buildRepo(db).bulkCreate([rp({ TS: 2, MRC_DATE: "2026-10-20" })], { matchOn: "mmh_mrc_no" });
    assert.equal(state.matchedOn, "mmh_mrc_no");
    assert.equal(state.inserts, 0);
    assert.equal(state.updates, 1);
    assert.equal(state.rows.length, 1);
  });

  it("an older year's bill with the same reference is a different bill: inserted, old row untouched", async () => {
    const { db, state } = makeDb([
      existingRow({ purchase_id: 5, mmh_mrc_refno: "6372", mmh_mrc_no: "118000", mmh_mrc_dt: "2025-07-01", ts: 1 }),
    ]);
    await buildRepo(db).bulkCreate([rp()], { matchOn: "mmh_mrc_no" });
    assert.equal(state.inserts, 1);
    assert.equal(state.updates, 0);
    assert.equal(state.rows.find((r) => r.purchase_id === 5).ts, 1, "the 2025 bill is not rewritten");
  });

  it("the GoFrugal push still matches on the refno by default", async () => {
    const { db, state } = makeDb([]);
    await buildRepo(db).bulkCreate([payload()]);
    assert.equal(state.matchedOn, "mmh_mrc_refno");
  });

  it("refuses any other match column", async () => {
    await assert.rejects(buildRepo(makeDb([]).db).bulkCreate([payload()], { matchOn: "supplier_id" }), /cannot match on supplier_id/);
  });
});

/* ============================================ round-off pre-fill ===== */
describe("pre-filling purchase_internal for RetailPilot bills", () => {
  const src = fs.readFileSync(path.join(__dirname, "purchase.js"), "utf8");
  const fn = src.slice(src.indexOf("async prefillPurchaseInternal("), src.indexOf("findByOutletRefnos(keys)"));

  it("writes only for an unapproved bill with no purchase_internal row, found by outlet and slug", () => {
    assert.match(fn, /INSERT INTO purchase_internal \(purchase_id, round_off, total_amount, supplier_credit_note\)/);
    assert.match(fn, /WHERE p\.retail_outlet_id = \? AND p\.mmh_mrc_no = \? AND p\.is_approved = 0/);
    assert.match(fn, /AND NOT EXISTS \(SELECT 1 FROM purchase_internal pi WHERE pi\.purchase_id = p\.purchase_id\)/);
    assert.doesNotMatch(fn, /UPDATE purchase_internal|ON DUPLICATE KEY|INSERT IGNORE/, "never overwrites accounts' entry");
  });

  it("counts what it wrote", async () => {
    const calls = [];
    const db = { query: (sql, params, cb) => { calls.push(params); cb(null, { affectedRows: params[3] === "INV-NEW" ? 1 : 0 }); } };
    const n = await buildRepo(db).prefillPurchaseInternal([
      { retail_outlet_id: 2, mmh_mrc_no: "INV-NEW", round_off: -0.2, total_amount: 4544 },
      { retail_outlet_id: 2, mmh_mrc_no: "INV-STARTED", round_off: 1, total_amount: 10 },
    ]);
    assert.equal(n, 1);
    assert.deepEqual(calls[0], [-0.2, 4544, 2, "INV-NEW"]);
  });
});
