/**
 * GRN No SEARCH - find a GRN by number without knowing its date.
 *
 *   node --test routes/grn_search.test.js
 *
 * The rules being pinned:
 *
 *   ANY DATE        `GET /grn/search?q=` passes no date to the repository and
 *                   the repository's SQL has no date condition, so a GRN from
 *                   another month or year is found from any screen.
 *   EXACT FIRST     the SQL ranks `MMH_MRC_REFNO = q` above prefix matches.
 *   INDEXABLE       the match is a PREFIX LIKE (never `%q%`), its wildcards
 *                   escaped, and the header rows are capped before the join.
 *   PERMISSION      the route is guarded by `view_all_grn`, the key the All
 *                   GRN screen is gated on; a caller without it gets a 403
 *                   and the repository is never queried.
 *   SAME ROWS       results have the list's shape, verification included.
 *   THE INDEX       boot ensures an index leading with MMH_MRC_REFNO, and
 *                   adds nothing when the table already has one.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("../usecase/grn");
const buildRepo = require("../repository/stock_received");
const P = require("../constants/grn_permissions");
const { ensureGofrugalIndexes } = require("../utils/ensureGofrugalIndexes");

/* ------------------------------------------------------- test doubles ---- */

const HISTORY = [
  { mmh_mrc_refno: "5972", mmh_mrc_dt: "2026-09-18" },
  { mmh_mrc_refno: "59721", mmh_mrc_dt: "2026-10-01" },
  { mmh_mrc_refno: "5901", mmh_mrc_dt: "2025-08-03" },
  { mmh_mrc_refno: "6100", mmh_mrc_dt: "2026-10-02" },
];

/** A repository over a fixed GRN history, matching the way the SQL does. */
function fakeRepo(history = HISTORY) {
  const calls = { search: [], list: [] };
  return {
    calls,
    searchGrnHeaders: async (term, limit) => {
      calls.search.push({ term, limit });
      const key = String(term);
      return history
        .filter((g) => g.mmh_mrc_refno.startsWith(key))
        .sort(
          (a, b) =>
            (b.mmh_mrc_refno === key) - (a.mmh_mrc_refno === key) ||
            b.mmh_mrc_dt.localeCompare(a.mmh_mrc_dt)
        )
        .slice(0, limit)
        .map((g) => ({ ...g, supplier_name: "ACME", mmh_mrc_amt: 10, product_count: 2 }));
    },
    listGrnHeaders: async (filters) => {
      calls.list.push(filters);
      return history
        .filter((g) => g.mmh_mrc_dt >= filters.from_date && g.mmh_mrc_dt <= filters.to_date)
        .map((g) => ({ ...g, supplier_name: "ACME", mmh_mrc_amt: 10, product_count: 2 }));
    },
    listGrnVerificationsByRefnos: async () => [
      {
        mmh_mrc_refno: "5972",
        verified_by: 7,
        verified_by_name: "Asha R",
        verified_at: "2026-09-15T08:00:00Z",
      },
    ],
  };
}

const tagging = {
  require: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { mode: "any", keys };
    return mw;
  },
  requireAll: () => (req, res, next) => next(),
  has: async () => true,
};

function enforcing(heldKeys) {
  const held = new Set(heldKeys);
  return {
    require: (...keys) => (req, res, next) => {
      if (!req.decoded) return res.status(401).json({ code: 401, msg: "Unauthorized" });
      if (keys.some((k) => held.has(k))) return next();
      return res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    },
    requireAll: () => (req, res, next) => next(),
    has: async () => held.size > 0,
  };
}

function freshRoutes(usecase, permissions) {
  delete require.cache[require.resolve("./grn")];
  return require("./grn")(usecase, permissions);
}

function routeOf(usecase, permissions, method, path) {
  for (const layer of freshRoutes(usecase, permissions).getRouter().stack) {
    if (!layer.route || layer.route.path !== path) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;
    return {
      guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
      stack: layer.route.stack.map((s) => s.handle),
    };
  }
  return null;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  res.end = () => res;
  return res;
}

async function call(route, req) {
  const res = fakeRes();
  for (const handle of route.stack) {
    let advanced = false;
    await handle(req, res, () => {
      advanced = true;
    });
    if (!advanced) return res;
  }
  return res;
}

const viewer = { decoded: { employee_id: 3, designation_id: 9, user_type: 1 } };

/** A GoFrugal pool that records each statement and answers with `rows`. */
function recordingDb(rows = []) {
  const queries = [];
  return {
    queries,
    query: (sql, params, cb) => {
      queries.push({ sql, params });
      cb(null, rows);
    },
  };
}

/* ------------------------------------------------------------- the tests */

describe("GET /grn/search", () => {
  it("is registered and guarded by view_all_grn", () => {
    const route = routeOf(buildUsecase(fakeRepo()), tagging, "GET", "/search");
    assert.ok(route, "the search route is registered");
    assert.deepEqual(route.guard, { mode: "any", keys: [P.VIEW_ALL_GRN] });
  });

  it("finds a GRN dated outside the month on screen, with no date sent", async () => {
    const repo = fakeRepo();
    const route = routeOf(buildUsecase(repo), tagging, "GET", "/search");

    // The screen is on 02/10/2026; 5972 was received on 18/09/2026.
    const res = await call(route, { ...viewer, query: { q: "5972", from_date: "2026-10-02", to_date: "2026-10-02" } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data[0].mmh_mrc_refno, "5972");
    assert.equal(res.body.data[0].mmh_mrc_dt, "2026-09-18");
    assert.deepEqual(repo.calls.list, [], "the date-filtered list is not involved");
    assert.equal(repo.calls.search.length, 1);
    assert.deepEqual(Object.keys(repo.calls.search[0]).sort(), ["limit", "term"]);
  });

  it("puts the exact GRN first, then the other prefix matches", async () => {
    const route = routeOf(buildUsecase(fakeRepo()), tagging, "GET", "/search");

    const exact = await call(route, { ...viewer, query: { q: "5972" } });
    assert.deepEqual(exact.body.data.map((r) => r.mmh_mrc_refno), ["5972", "59721"]);

    const partial = await call(route, { ...viewer, query: { q: "59" } });
    assert.deepEqual(
      partial.body.data.map((r) => r.mmh_mrc_refno).sort(),
      ["5901", "5972", "59721"]
    );
    assert.ok(!partial.body.data.some((r) => r.mmh_mrc_refno === "6100"));
  });

  it("returns the list's row shape, verification included", async () => {
    const route = routeOf(buildUsecase(fakeRepo()), tagging, "GET", "/search");
    const res = await call(route, { ...viewer, query: { q: "59" } });
    const byRefno = Object.fromEntries(res.body.data.map((r) => [r.mmh_mrc_refno, r]));

    assert.equal(byRefno["5972"].supplier_name, "ACME");
    assert.equal(byRefno["5972"].product_count, 2);
    assert.equal(byRefno["5972"].verification.status, "VERIFIED");
    assert.equal(byRefno["5972"].verification.verified_by_name, "Asha R");
    assert.equal(byRefno["59721"].verification.status, "PENDING");
    // A 2025 GRN predates verification, exactly as on the list.
    assert.equal(byRefno["5901"].verification, null);
    assert.equal(res.body.meta.truncated, false);
  });

  it("caps the results and says so", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      mmh_mrc_refno: `7${String(i).padStart(3, "0")}`,
      mmh_mrc_dt: "2026-09-01",
    }));
    const route = routeOf(buildUsecase(fakeRepo(many)), tagging, "GET", "/search");
    const res = await call(route, { ...viewer, query: { q: "7" } });

    assert.equal(res.body.data.length, 50);
    assert.equal(res.body.meta.limit, 50);
    assert.equal(res.body.meta.truncated, true);
  });

  it("refuses a caller without view_all_grn and never queries", async () => {
    const repo = fakeRepo();
    const route = routeOf(buildUsecase(repo), enforcing([P.VERIFY_GRN]), "GET", "/search");
    const res = await call(route, { ...viewer, query: { q: "5972" } });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data, undefined);
    assert.deepEqual(repo.calls.search, []);
  });

  it("refuses an unauthenticated caller", async () => {
    const repo = fakeRepo();
    const route = routeOf(buildUsecase(repo), enforcing([P.VIEW_ALL_GRN]), "GET", "/search");
    const res = await call(route, { query: { q: "5972" } });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(repo.calls.search, []);
  });

  it("lets a view_all_grn holder through", async () => {
    const route = routeOf(buildUsecase(fakeRepo()), enforcing([P.VIEW_ALL_GRN]), "GET", "/search");
    const res = await call(route, { ...viewer, query: { q: "5972" } });
    assert.equal(res.statusCode, 200);
  });

  it("rejects an empty or over-long term", async () => {
    const repo = fakeRepo();
    const route = routeOf(buildUsecase(repo), tagging, "GET", "/search");

    assert.equal((await call(route, { ...viewer, query: {} })).statusCode, 400);
    assert.equal((await call(route, { ...viewer, query: { q: "   " } })).statusCode, 400);
    assert.equal((await call(route, { ...viewer, query: { q: "9".repeat(51) } })).statusCode, 400);
    assert.deepEqual(repo.calls.search, []);
  });

  it("leaves /list and /detail as they were", () => {
    const usecase = buildUsecase(fakeRepo());
    assert.equal(routeOf(usecase, tagging, "GET", "/list").guard, null);
    assert.equal(routeOf(usecase, tagging, "GET", "/detail").guard, null);
  });
});

describe("stock_received.searchGrnHeaders SQL", () => {
  it("is a prefix match with no date condition, exact match ranked first", async () => {
    const db = recordingDb([
      { mmh_mrc_no: 1, mmh_mrc_refno: "5972", mmh_mrc_dt: "2026-09-14", mmh_dist_code: "D1", mmh_mrc_amt: "10.5", supplier_name: "ACME", product_count: 3 },
    ]);
    const rows = await buildRepo(null, db).searchGrnHeaders(" 5972 ", 51);
    const { sql, params } = db.queries[0];

    assert.deepEqual(params, ["5972", "5972%", 51]);
    assert.match(sql, /MMH_MRC_REFNO LIKE \?/);
    assert.match(sql, /\(hh\.MMH_MRC_REFNO = \?\) AS is_exact/);
    assert.match(sql, /ORDER BY h\.is_exact DESC/);
    assert.ok(!/MMH_MRC_DT\)? *[<>]=/.test(sql), "no date filter");
    assert.ok(!/LIKE CONCAT\('%'/.test(sql) && !/'%' *\?/.test(sql), "never a contains match");
    // Capped in the inner query, before the detail join.
    assert.ok(sql.indexOf("LIMIT ?") < sql.indexOf("LEFT JOIN"));

    assert.deepEqual(rows[0], {
      mmh_mrc_no: 1,
      mmh_mrc_refno: "5972",
      mmh_mrc_dt: "2026-09-14",
      mmh_dist_code: "D1",
      supplier_name: "ACME",
      mmh_mrc_amt: 10.5,
      product_count: 3,
    });
  });

  it("escapes LIKE wildcards so they match literally", async () => {
    const db = recordingDb();
    await buildRepo(null, db).searchGrnHeaders("5%_\\", 10);
    assert.equal(db.queries[0].params[1], "5\\%\\_\\\\%");
  });

  it("does not query for an empty term, and bounds the limit", async () => {
    const db = recordingDb();
    const repo = buildRepo(null, db);
    assert.deepEqual(await repo.searchGrnHeaders("  ", 10), []);
    assert.equal(db.queries.length, 0);
    await repo.searchGrnHeaders("1", 100000);
    assert.equal(db.queries[0].params[2], 200);
  });
});

describe("GoFrugal GRN No index on boot", () => {
  function indexDb({ hasRefnoIndex, failDtl = false }) {
    const statements = [];
    return {
      statements,
      query: (sql, params, cb) => {
        if (typeof params === "function") {
          cb = params;
          params = [];
        }
        statements.push({ sql, params });
        if (/information_schema/.test(sql)) {
          const isHdr = params[0] === "medishopdb_MED_MRC_HDR";
          if (!isHdr && failDtl) return cb(new Error("denied"));
          return cb(null, [{ cnt: isHdr ? (hasRefnoIndex ? 1 : 0) : 1 }]);
        }
        cb(null, []);
      },
    };
  }

  it("adds an index on MMH_MRC_REFNO when the header table has none", async () => {
    const db = indexDb({ hasRefnoIndex: false });
    await ensureGofrugalIndexes(db);
    const alters = db.statements.filter((s) => /ALTER TABLE/.test(s.sql));
    assert.equal(alters.length, 1);
    assert.match(alters[0].sql, /`medishopdb_MED_MRC_HDR`/);
    assert.match(alters[0].sql, /ADD INDEX `idx_med_mrc_hdr_mrc_refno` \(MMH_MRC_REFNO\)/);
  });

  it("adds nothing when an index already leads with MMH_MRC_REFNO", async () => {
    const db = indexDb({ hasRefnoIndex: true });
    await ensureGofrugalIndexes(db);
    assert.equal(db.statements.filter((s) => /ALTER TABLE/.test(s.sql)).length, 0);
    const hdrCheck = db.statements.find((s) => s.params[0] === "medishopdb_MED_MRC_HDR");
    assert.match(hdrCheck.sql, /column_name = \? AND seq_in_index = 1/);
    assert.equal(hdrCheck.params[2], "MMH_MRC_REFNO");
  });

  it("still checks the header index when the detail one fails", async () => {
    const db = indexDb({ hasRefnoIndex: false, failDtl: true });
    await ensureGofrugalIndexes(db);
    assert.equal(db.statements.filter((s) => /ALTER TABLE `medishopdb_MED_MRC_HDR`/.test(s.sql)).length, 1);
  });
});
