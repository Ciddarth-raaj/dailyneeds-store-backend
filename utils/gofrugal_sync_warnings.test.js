/**
 * A sync key warning has to REACH somebody.
 *
 *   node --test utils/gofrugal_sync_warnings.test.js
 *
 * The receiver reporting a key mismatch in its response is only useful if
 * that report is recorded. It is: `POST /gofrugal-synker/sync` already goes
 * through the api sync logger middleware, and extractMetadata copies
 * `payload.warnings` into the api_sync_log metadata alongside the table name
 * and row count. This pins that link, because it is the difference between a
 * warning somebody can find weeks later and one that vanished into an HTTP
 * response nobody read.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractMetadata } = require("./api_sync_log_helpers");

const req = (body) => ({ body, baseUrl: "/gofrugal-synker", path: "/sync" });

describe("gofrugal_synker_sync log metadata", () => {
  it("records a key mismatch warning against the table it concerns", () => {
    const metadata = extractMetadata(
      "gofrugal_synker_sync",
      req({
        table_name: "medishopdb_MED_MRC_HDR",
        table_items: [{ MMH_MRC_NO: "1" }, { MMH_MRC_NO: "2" }],
      }),
      {
        code: 200,
        msg: "Synced",
        warnings: [
          "medishopdb_MED_MRC_HDR key mismatch: request asked for (MMH_MRC_NO) but the table is keyed on (MMH_MRC_REFNO)",
        ],
      }
    );

    assert.equal(metadata.table_name, "medishopdb_MED_MRC_HDR");
    assert.equal(metadata.row_count, 2);
    assert.equal(metadata.warnings.length, 1);
    assert.match(metadata.warnings[0], /key mismatch/);
  });

  it("a clean sync logs no warnings key at all", () => {
    const metadata = extractMetadata(
      "gofrugal_synker_sync",
      req({ table_name: "medishopdb_MED_MRC_DTL", table_items: [{}] }),
      { code: 200, msg: "Synced" }
    );

    assert.equal(metadata.warnings, undefined);
    assert.equal(metadata.table_name, "medishopdb_MED_MRC_DTL");
  });
});
