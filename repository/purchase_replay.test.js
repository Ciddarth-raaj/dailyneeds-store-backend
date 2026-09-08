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

      if (/^SELECT \* FROM purchase WHERE mmh_mrc_refno = \? AND retail_outlet_id = \?/.test(text)) {
        state.selects += 1;
        const [refno, outlet] = params;
        const found = state.rows.filter(
          (r) => r.mmh_mrc_refno === refno && Number(r.retail_outlet_id) === Number(outlet)
        );
        cb(null, found.map((r) => ({ ...r })));
        return;
      }

      if (/^UPDATE purchase SET/.test(text)) {
        state.updates += 1;
        // The refno and outlet are the last two bound parameters.
        const outlet = params[params.length - 1];
        const refno = params[params.length - 2];
        const row = state.rows.find(
          (r) => r.mmh_mrc_refno === refno && Number(r.retail_outlet_id) === Number(outlet)
        );
        if (row) {
          row.ts = params[8];
          row.mmh_mrc_amt = params[5];
          row.has_updated = params[params.length - 4];
          row.is_approved = params[params.length - 3];
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
      /SELECT \* FROM purchase WHERE mmh_mrc_refno = \? AND retail_outlet_id = \?/,
      "the existence check must be on the natural key"
    );
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
