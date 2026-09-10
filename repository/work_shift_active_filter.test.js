/**
 * GET /work-shift gains an optional `active` filter, and nothing else changes.
 *
 *   node --test repository/work_shift_active_filter.test.js
 *
 * The Employee Shift Assignment screen must offer ACTIVE work shifts only, and
 * the smallest way to give it that is a filter on the list it already calls.
 * The risk in touching a shared list endpoint is the existing caller: the Work
 * Shift Master list needs the inactive shifts too, because the switch in its
 * Status column is the only way to bring one back. So the assertion that
 * matters here is the unfiltered call — it must produce exactly the query it
 * always did.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./work_shift");
const buildUsecase = require("../usecase/work_shift");

/** Captures the SQL and the bound parameters instead of running them. */
function makeDb() {
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, []);
    },
  };
}

describe("repository.get", () => {
  it("is unchanged when no filter is asked for", async () => {
    const db = makeDb();
    await buildRepo(db).get();
    assert.deepEqual(db.calls, [
      { sql: "SELECT * FROM work_shift ORDER BY shift_code ASC", params: [] },
    ]);
  });

  it("is also unchanged when called with no argument at all", async () => {
    const db = makeDb();
    await buildRepo(db).get({});
    assert.equal(db.calls[0].sql, "SELECT * FROM work_shift ORDER BY shift_code ASC");
    assert.deepEqual(db.calls[0].params, []);
  });

  it("narrows to active shifts, with the flag bound rather than interpolated", async () => {
    const db = makeDb();
    await buildRepo(db).get({ active: true });
    assert.equal(db.calls[0].sql, "SELECT * FROM work_shift WHERE active = ? ORDER BY shift_code ASC");
    assert.deepEqual(db.calls[0].params, [1]);
  });

  it("narrows to inactive shifts too", async () => {
    const db = makeDb();
    await buildRepo(db).get({ active: false });
    assert.deepEqual(db.calls[0].params, [0]);
  });
});

describe("usecase.get", () => {
  it("passes the filter through and defaults to everything", async () => {
    const asked = [];
    const usecase = buildUsecase({
      async get(options) {
        asked.push(options);
        return [];
      },
    });

    await usecase.get();
    await usecase.get({ active: true });

    assert.equal(asked[0].active, undefined);
    assert.equal(asked[1].active, true);
  });
});
