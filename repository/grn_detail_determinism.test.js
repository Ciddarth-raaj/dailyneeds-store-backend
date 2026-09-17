/**
 * /grn/detail must answer the same way twice.
 *
 *   node --test repository/grn_detail_determinism.test.js
 *
 * `SELECT ... WHERE MMH_MRC_REFNO = ? LIMIT 1` with no ORDER BY lets MySQL
 * return whichever matching header it reaches first. That is stable only
 * while exactly one header matches, and the sync table can hold more than
 * one - a duplicated header is precisely what a mis-keyed upsert produces.
 * Without an ORDER BY the page could then show either row, and a different
 * one on the next refresh.
 *
 * This asserts the ordering exists. It is NOT the fix for duplicate rows -
 * two copies of the same header with the same memo number are still two
 * copies, and that is a data problem for
 * scripts/diagnostics/gofrugal-sync-key-audit.js to surface.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./stock_received");

function capturingGofrugalDb() {
  const queries = [];
  return {
    queries,
    query(sql, params, cb) {
      queries.push({ sql, params });
      // No header: the repository resolves null and asks nothing further.
      cb(null, []);
    },
  };
}

describe("listGrnDetailByRefno", () => {
  it("orders the header lookup before taking one row", async () => {
    const db = capturingGofrugalDb();
    const repo = buildRepo(null, db);

    const detail = await repo.listGrnDetailByRefno("GRN-1");

    assert.equal(detail, null);
    const sql = db.queries[0].sql;
    assert.match(sql, /WHERE h\.MMH_MRC_REFNO = \?/);
    assert.match(sql, /ORDER BY h\.MMH_MRC_NO DESC/);
    // The ordering has to come before the LIMIT to decide anything.
    // lastIndexOf, because an explanatory comment in the query names LIMIT 1
    // above the clause itself.
    assert.ok(
      sql.indexOf("ORDER BY h.MMH_MRC_NO DESC") < sql.lastIndexOf("LIMIT 1"),
      "ORDER BY precedes LIMIT"
    );
    assert.deepEqual(db.queries[0].params, ["GRN-1"]);
  });
});
