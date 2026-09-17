/**
 * THE GRN SYNC RECEIVER - what it upserts on, and what it does when the
 * table disagrees with the request.
 *
 *   node --test usecase/gofrugal_synker.test.js
 *
 * THE REGRESSION THESE PIN. `ensureTable` is a CREATE TABLE IF NOT EXISTS, so
 * a table's PRIMARY KEY is whatever the first request that created it asked
 * for. Every later request's `unique_keys` is validated against table_config
 * and then has no effect at all - the upsert keeps matching rows by the key
 * the table already has. When that key no longer identifies one source row,
 * `ON DUPLICATE KEY UPDATE` finds nothing to update and INSERTS a second row:
 * new records still appear, edits to existing ones land in a copy nothing
 * reads. That is the shape of "GRN edits stopped reflecting on /grn", and
 * until this check existed the response said "Synced" either way.
 *
 * So these tests assert two different things:
 *
 *   THE UPSERT STILL HAPPENS, unchanged, and every non-key column is
 *   updated from the incoming row. An edited row that reaches a
 *   correctly-keyed table does update it - the receiver was never the part
 *   that dropped edits, and this test is what would catch a "fix" that
 *   started filtering them.
 *
 *   A DISAGREEMENT IS REPORTED, loudly, in the response and therefore in
 *   api_sync_log. Never silently, and never by refusing the sync - refusing
 *   would stop new rows arriving too.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./gofrugal_synker");

const HDR_CONFIG = [
  { name: "MMH_MRC_NO", type: "VARCHAR(50)" },
  { name: "MMH_MRC_REFNO", type: "VARCHAR(50)" },
  { name: "MMH_MRC_AMT", type: "DECIMAL(14,2)" },
];
const DTL_KEYS = ["MMD_MRC_NO", "MMD_MRC_SL_NO"];

/**
 * A synker repository stand-in. `primaryKey` is what the TABLE has, which is
 * deliberately separate from the unique_keys a request asks for - the gap
 * between those two is the whole subject of this file.
 */
function fakeRepo({ primaryKey = ["MMH_MRC_NO"], counts = null } = {}) {
  const calls = { ensure: [], upsert: [], keyReads: 0, countReads: 0 };
  return {
    calls,
    ensureTable: async (table, config, keys) => {
      calls.ensure.push({ table, config, keys });
    },
    getPrimaryKeyColumns: async () => {
      calls.keyReads += 1;
      return primaryKey;
    },
    countRowsByKeys: async (table, keys) => {
      calls.countReads += 1;
      return counts ?? { total_rows: 10, distinct_keys: 10 };
    },
    upsertBatch: async (table, columns, items, keys) => {
      calls.upsert.push({ table, columns, items, keys });
      return { inserted: items.length };
    },
  };
}

const syncHeaders = (usecase, keys = ["MMH_MRC_NO"], items = [{ MMH_MRC_NO: "1" }]) =>
  usecase.syncTable("medishopdb_MED_MRC_HDR", HDR_CONFIG, keys, items);

describe("syncTable upserts edited rows", () => {
  it("still sends every row to the upsert, edits included", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);

    // The same source row as an earlier sync, with a changed amount.
    const edited = [
      { MMH_MRC_NO: "1", MMH_MRC_REFNO: "GRN-1", MMH_MRC_AMT: "250.00" },
    ];
    const res = await syncHeaders(usecase, ["MMH_MRC_NO"], edited);

    assert.equal(res.code, 200);
    assert.equal(res.rows, 1);
    assert.equal(repo.calls.upsert.length, 1);
    assert.deepEqual(repo.calls.upsert[0].items, edited);
    // Every column travels, so ON DUPLICATE KEY UPDATE can refresh them all.
    assert.deepEqual(repo.calls.upsert[0].columns, [
      "MMH_MRC_NO",
      "MMH_MRC_REFNO",
      "MMH_MRC_AMT",
    ]);
  });

  it("does not filter rows against what is already stored", async () => {
    // getExistingRows exists on the repository and has no caller. If a change
    // ever wires it in as a "only send what changed" optimisation, an edit
    // that the sender resent would start being dropped here.
    const repo = fakeRepo();
    repo.getExistingRows = async () => {
      throw new Error("the receiver must not pre-filter incoming rows");
    };
    const usecase = buildUsecase(repo);

    const res = await syncHeaders(usecase);
    assert.equal(res.rows, 1);
    assert.equal(repo.calls.upsert.length, 1);
  });

  it("reports no warnings when the table's key is the requested one", async () => {
    const repo = fakeRepo({ primaryKey: ["MMH_MRC_NO"] });
    const res = await syncHeaders(buildUsecase(repo), ["MMH_MRC_NO"]);

    assert.equal(res.warnings, undefined);
    assert.equal(repo.calls.keyReads, 1);
  });

  it("accepts a key that differs only in order or case", async () => {
    // The index order differs; which rows collide does not.
    const repo = fakeRepo({ primaryKey: ["MMD_MRC_SL_NO", "mmd_mrc_no"] });
    const usecase = buildUsecase(repo);

    const res = await usecase.syncTable(
      "medishopdb_MED_MRC_DTL",
      DTL_KEYS.map((name) => ({ name, type: "VARCHAR(50)" })).concat({
        name: "MMD_PUR_PRICE",
        type: "DECIMAL(14,4)",
      }),
      DTL_KEYS,
      [{ MMD_MRC_NO: "1", MMD_MRC_SL_NO: "1", MMD_PUR_PRICE: "9.50" }]
    );

    assert.equal(res.warnings, undefined);
  });
});

describe("syncTable reports a key the table does not actually have", () => {
  it("warns when the stored key is not the requested key", async () => {
    // The table was created on MMH_MRC_REFNO; the sender now keys on
    // MMH_MRC_NO. CREATE TABLE IF NOT EXISTS changed nothing, so the upsert
    // is still matching on the old column.
    const repo = fakeRepo({ primaryKey: ["MMH_MRC_REFNO"] });
    const res = await syncHeaders(buildUsecase(repo), ["MMH_MRC_NO"]);

    assert.ok(Array.isArray(res.warnings) && res.warnings.length >= 1);
    assert.match(res.warnings[0], /key mismatch/i);
    assert.match(res.warnings[0], /MMH_MRC_NO/);
    assert.match(res.warnings[0], /MMH_MRC_REFNO/);
  });

  it("warns when the table has no primary key at all", async () => {
    const repo = fakeRepo({ primaryKey: [] });
    const res = await syncHeaders(buildUsecase(repo));

    assert.ok(res.warnings.some((w) => /NO PRIMARY KEY/i.test(w)));
  });

  it("warns when duplicate source rows are already stored", async () => {
    // The fingerprint of an upsert that has been inserting instead of
    // updating: more rows than distinct source keys.
    const repo = fakeRepo({
      primaryKey: ["MMH_MRC_NO"],
      counts: { total_rows: 1200, distinct_keys: 1000 },
    });
    const res = await syncHeaders(buildUsecase(repo));

    const dupWarning = res.warnings.find((w) => /duplicate source rows/i.test(w));
    assert.ok(dupWarning, "the duplicate count is reported");
    assert.match(dupWarning, /200 duplicate source rows/);
  });

  it("SYNCS ANYWAY, so new rows keep arriving while the key is wrong", async () => {
    const repo = fakeRepo({ primaryKey: ["MMH_MRC_REFNO"] });
    const res = await syncHeaders(buildUsecase(repo), ["MMH_MRC_NO"]);

    assert.equal(res.code, 200);
    assert.equal(repo.calls.upsert.length, 1, "the upsert still ran");
  });

  it("never alters the table to fix the key by itself", async () => {
    const repo = fakeRepo({ primaryKey: ["MMH_MRC_REFNO"] });
    repo.alterTable = async () => {
      throw new Error("a sync request must not rebuild a production key");
    };
    const usecase = buildUsecase(repo);

    await syncHeaders(usecase, ["MMH_MRC_NO"]);
    // Only the four read/write calls the sync is supposed to make.
    assert.equal(repo.calls.ensure.length, 1);
    assert.equal(repo.calls.keyReads, 1);
    assert.equal(repo.calls.countReads, 1);
    assert.equal(repo.calls.upsert.length, 1);
  });

  it("keeps syncing when the inspection itself cannot run", async () => {
    // A locked-down user with no SHOW KEYS grant must not break the sync.
    const repo = fakeRepo();
    repo.getPrimaryKeyColumns = async () => {
      throw new Error("SHOW KEYS command denied");
    };
    const res = await syncHeaders(buildUsecase(repo));

    assert.equal(res.code, 200);
    assert.equal(res.warnings, undefined);
    assert.equal(repo.calls.upsert.length, 1);
  });

  it("inspects the key even when the request carries no rows", async () => {
    const repo = fakeRepo({ primaryKey: ["MMH_MRC_REFNO"] });
    const res = await syncHeaders(buildUsecase(repo), ["MMH_MRC_NO"], []);

    assert.equal(res.rows, 0);
    assert.equal(repo.calls.upsert.length, 0);
    assert.ok(res.warnings.length >= 1, "an empty sync still reports the key");
  });
});
