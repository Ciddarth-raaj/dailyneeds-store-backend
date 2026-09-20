/**
 * DigiSME is an ingestion source, never a device.
 *
 *   node --test repository/biomax_device_source_scope.test.js
 *
 * The Biomax Devices screen answers questions about PHYSICAL BM70W
 * TERMINALS. The DigiSME Excel import and the DigiSME API sync both write
 * `dev_id = NULL` with `ingest_source = 'DIGISME_IMPORT'`
 * (biomax/store.js insertImportedPunch), so any query that reaches for
 * "punches with no matching biomax_device" sweeps them in: they fail the
 * join on a NULL dev_id and every one of them collapses into a single
 * phantom "unregistered device" with no Cloud ID and a punch count in the
 * thousands.
 *
 * These assert the SQL the repository SENDS - the predicates are present
 * and spelled the way the schema means them. They do not execute it: there
 * is no MySQL here, and translating DATE_FORMAT/STR_TO_DATE into some other
 * engine would only prove things about the translation. What they pin is
 * the thing that regressed, which is the WHERE clause going missing.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepository = require("./biomax_device");

/** A db whose only job is to record the SQL and hand back rows. */
function recordingDb(rows = []) {
  const log = [];
  return {
    log,
    query(sql, params, cb) {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, rows);
    },
  };
}

const unregisteredSql = async (rows) => {
  const db = recordingDb(rows);
  await buildRepository(db).unregisteredSeen();
  return db.log[0].sql;
};

describe("Unregistered devices seen is scoped to live terminal traffic", () => {
  it("asks only for LIVE rows", async () => {
    assert.match(await unregisteredSql(), /p\.ingest_source = 'LIVE'/);
  });

  it("refuses rows with no Cloud ID, which is every DigiSME row", async () => {
    assert.match(await unregisteredSql(), /p\.dev_id IS NOT NULL/);
  });

  it("still requires the device to be absent from the registry", async () => {
    assert.match(await unregisteredSql(), /bd\.biomax_device_id IS NULL/);
  });

  it("carries all three conditions together, not one instead of another", async () => {
    const sql = await unregisteredSql();
    const where = sql.slice(sql.indexOf("WHERE"), sql.indexOf("GROUP BY"));
    for (const clause of ["p.ingest_source = 'LIVE'", "p.dev_id IS NOT NULL", "bd.biomax_device_id IS NULL"]) {
      assert.ok(where.includes(clause), `WHERE is missing ${clause}`);
    }
  });

  it("names neither DIGISME_IMPORT nor HISTORICAL_PULL as something it accepts", async () => {
    const sql = await unregisteredSql();
    assert.ok(!/ingest_source\s*=\s*'DIGISME_IMPORT'/.test(sql));
    assert.ok(!/ingest_source\s*=\s*'HISTORICAL_PULL'/.test(sql));
    assert.ok(!/ingest_source\s+IN\s*\(/i.test(sql), "a single source is meant, not a list");
  });

  it("returns what the database gives it, unfiltered in JS - the scope is the query's", async () => {
    // If the filtering ever migrates into JS, this row would have to be
    // dropped here; it is not, and that is deliberate.
    const rows = await buildRepository(recordingDb([{ dev_id: "UNKNOWN1", punches: 3 }])).unregisteredSeen();
    assert.deepEqual(rows, [{ dev_id: "UNKNOWN1", punches: 3 }]);
  });
});

describe("what the fix does NOT touch", () => {
  it("the device list still counts punches by the device's own Cloud ID", async () => {
    const db = recordingDb([]);
    await buildRepository(db).list();
    const sql = db.log[0].sql;
    // A DigiSME row has dev_id NULL and can never equal bd.dev_id, so
    // Punches Today was never contaminated and stays exactly as it was.
    assert.match(sql, /WHERE p\.dev_id = bd\.dev_id AND p\.punch_date = CURDATE\(\)/);
  });

  it("connectivity still reads last_seen_at, which no import can move", async () => {
    const db = recordingDb([]);
    await buildRepository(db).list();
    assert.match(db.log[0].sql, /bd\.last_seen_at/);
  });
});
