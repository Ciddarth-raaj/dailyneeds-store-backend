/**
 * THE SQL THE GRN SYNC RECEIVER ISSUES.
 *
 *   node --test repository/gofrugal_synker.test.js
 *
 * Three facts about the receiver that the incident hinged on, asserted
 * against the statements it actually builds:
 *
 *   THE UPSERT UPDATES EVERY NON-KEY COLUMN. `INSERT ... ON DUPLICATE KEY
 *   UPDATE col = VALUES(col)` for each column that is not part of the key -
 *   so a resent row with changed values overwrites the stored one. The
 *   receiver is not where edits go missing, and this is the test that stays
 *   behind to prove it.
 *
 *   ensureTable CANNOT RE-KEY AN EXISTING TABLE. It is CREATE TABLE IF NOT
 *   EXISTS, so the `unique_keys` of every request after the first one has no
 *   effect on the table whatsoever. This is asserted, not fixed: rebuilding a
 *   production key is a separate, approved operation.
 *
 *   THE REAL KEY CAN BE READ BACK, which is what turns that silent
 *   disagreement into something the sync log shows.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./gofrugal_synker");

function fakeDb(handlers = {}) {
  const queries = [];
  return {
    queries,
    query(sql, paramsOrCb, maybeCb) {
      const cb = typeof paramsOrCb === "function" ? paramsOrCb : maybeCb;
      const params = typeof paramsOrCb === "function" ? [] : paramsOrCb;
      queries.push({ sql, params });
      const hit = Object.entries(handlers).find(([key]) => sql.includes(key));
      const answer = hit ? hit[1] : [];
      const out = typeof answer === "function" ? answer(params) : answer;
      if (out instanceof Error) return cb(out);
      return cb(null, out);
    },
  };
}

const DTL = "medishopdb_MED_MRC_DTL";
const DTL_KEYS = ["MMD_MRC_NO", "MMD_MRC_SL_NO"];
const DTL_COLS = ["MMD_MRC_NO", "MMD_MRC_SL_NO", "MMD_PUR_PRICE", "MMD_MAX_RATE"];

describe("upsertBatch", () => {
  it("updates every non-key column, so a resent edited row overwrites the stored one", async () => {
    const db = fakeDb({ "INSERT INTO": { affectedRows: 2 } });
    const repo = buildRepo(db);

    await repo.upsertBatch(
      DTL,
      DTL_COLS,
      [
        {
          MMD_MRC_NO: "77",
          MMD_MRC_SL_NO: "1",
          MMD_PUR_PRICE: "12.50",
          MMD_MAX_RATE: "20.00",
        },
      ],
      DTL_KEYS
    );

    const sql = db.queries[0].sql;
    assert.match(sql, /ON DUPLICATE KEY UPDATE/);
    // The changed columns are refreshed...
    assert.match(sql, /`MMD_PUR_PRICE` = VALUES\(`MMD_PUR_PRICE`\)/);
    assert.match(sql, /`MMD_MAX_RATE` = VALUES\(`MMD_MAX_RATE`\)/);
    // ...and the key columns are not (updating them would move the row).
    assert.doesNotMatch(sql, /`MMD_MRC_NO` = VALUES/);
    assert.doesNotMatch(sql, /`MMD_MRC_SL_NO` = VALUES/);
    assert.deepEqual(db.queries[0].params, ["77", "1", "12.50", "20.00"]);
  });

  it("sends every row it is given, without consulting what is stored", async () => {
    const db = fakeDb({ "INSERT INTO": { affectedRows: 3 } });
    const repo = buildRepo(db);

    await repo.upsertBatch(
      DTL,
      DTL_COLS,
      [1, 2, 3].map((n) => ({
        MMD_MRC_NO: "77",
        MMD_MRC_SL_NO: String(n),
        MMD_PUR_PRICE: "1",
        MMD_MAX_RATE: "2",
      })),
      DTL_KEYS
    );

    assert.equal(db.queries.length, 1, "one batched statement");
    assert.equal(
      db.queries.filter((q) => /SELECT/i.test(q.sql)).length,
      0,
      "no read-before-write that could skip a row"
    );
    assert.equal(db.queries[0].params.length, 12);
  });

  it("refuses a table whose columns are all key, since nothing could be updated", async () => {
    const repo = buildRepo(fakeDb());
    await assert.rejects(
      () => repo.upsertBatch(DTL, DTL_KEYS, [{}], DTL_KEYS),
      /At least one non-unique column/
    );
  });
});

describe("ensureTable", () => {
  it("keys the table on unique_keys when it creates it", async () => {
    const db = fakeDb({ "CREATE TABLE": {} });
    const repo = buildRepo(db);

    await repo.ensureTable(
      DTL,
      DTL_COLS.map((name) => ({ name, type: "VARCHAR(50)" })),
      DTL_KEYS
    );

    assert.match(
      db.queries[0].sql,
      /PRIMARY KEY \(`MMD_MRC_NO`, `MMD_MRC_SL_NO`\)/
    );
  });

  it("CANNOT re-key a table that already exists", async () => {
    // IF NOT EXISTS is the whole problem: this statement is a no-op against
    // a table created earlier with a different key, and nothing about the
    // request says so. The receiver reports that separately rather than
    // rebuilding a production table on its own.
    const db = fakeDb({ "CREATE TABLE": {} });
    const repo = buildRepo(db);

    await repo.ensureTable(
      DTL,
      DTL_COLS.map((name) => ({ name, type: "VARCHAR(50)" })),
      DTL_KEYS
    );

    assert.match(db.queries[0].sql, /CREATE TABLE IF NOT EXISTS/);
    assert.doesNotMatch(db.queries[0].sql, /ALTER TABLE/);
    assert.doesNotMatch(db.queries[0].sql, /DROP/);
  });
});

describe("getPrimaryKeyColumns", () => {
  it("reads the table's real key, in key order", async () => {
    const db = fakeDb({
      "SHOW KEYS": [
        { Column_name: "MMD_MRC_SL_NO", Seq_in_index: 2 },
        { Column_name: "MMD_MRC_NO", Seq_in_index: 1 },
      ],
    });
    const repo = buildRepo(db);

    assert.deepEqual(await repo.getPrimaryKeyColumns(DTL), [
      "MMD_MRC_NO",
      "MMD_MRC_SL_NO",
    ]);
    assert.match(db.queries[0].sql, /SHOW KEYS FROM `medishopdb_MED_MRC_DTL`/);
  });

  it("reports a table with no primary key as an empty key, not an error", async () => {
    const repo = buildRepo(fakeDb({ "SHOW KEYS": [] }));
    assert.deepEqual(await repo.getPrimaryKeyColumns(DTL), []);
  });
});

describe("countRowsByKeys", () => {
  it("counts rows against distinct source keys", async () => {
    const db = fakeDb({
      "COUNT(DISTINCT": [{ total_rows: 1200, distinct_keys: 1000 }],
    });
    const repo = buildRepo(db);

    assert.deepEqual(await repo.countRowsByKeys(DTL, DTL_KEYS), {
      total_rows: 1200,
      distinct_keys: 1000,
    });
    assert.match(
      db.queries[0].sql,
      /COUNT\(DISTINCT `MMD_MRC_NO`, `MMD_MRC_SL_NO`\)/
    );
  });

  it("only reads", async () => {
    const db = fakeDb({ "COUNT(DISTINCT": [{ total_rows: 1, distinct_keys: 1 }] });
    const repo = buildRepo(db);

    await repo.countRowsByKeys(DTL, DTL_KEYS);
    await repo.getPrimaryKeyColumns(DTL);

    for (const q of db.queries) {
      assert.doesNotMatch(q.sql, /\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/i);
    }
  });
});
