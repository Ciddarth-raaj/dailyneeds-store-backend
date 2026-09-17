/**
 * GRN VERIFICATION - who may sign a GRN off, what gets recorded, and what a
 * second click does.
 *
 *   node --test routes/grn_verification.test.js
 *
 * The rules being pinned, each of which is a way this could go wrong:
 *
 *   PERMISSION      `POST /grn/:refno/verify` is guarded by `verify_grn` and
 *                   by nothing else. `view_all_grn` says who may LOOK at a
 *                   GRN and must not, on its own, sign one off.
 *   THE APPROVER    comes from `req.decoded.employee_id` - the authenticated
 *                   session - and a `verified_by` in the request body is
 *                   ignored. This is the test that fails if somebody ever
 *                   "conveniently" reads the id off the payload.
 *   THE TIME        is the database's. The usecase hands the repository a
 *                   refno and an employee id and NOTHING ELSE; the column
 *                   default writes the timestamp.
 *   NO OVERWRITE    a GRN that is already verified answers 200 with the
 *                   ORIGINAL verifier and time, and the write it issues is an
 *                   INSERT IGNORE that changed no row.
 *   PENDING         a GRN with no verification row reads as PENDING, which is
 *                   every GRN that predates this feature.
 *   LIST / DETAIL   carry the verification block (name included) so the grid
 *                   needs no per-row lookup.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("../usecase/grn");
const P = require("../constants/grn_permissions");

/* ------------------------------------------------------- test doubles ---- */

/**
 * A stand-in for the stock_received repository's verification surface,
 * behaving the way the real table does: one row per refno, the UNIQUE key
 * refusing the second insert, and the timestamp set by the store rather than
 * the caller.
 */
function fakeRepo({ refnos = ["GRN-1"], verified = null } = {}) {
  const rows = new Map();
  const calls = { inserts: [] };
  if (verified) rows.set(String(verified.mmh_mrc_refno), { ...verified });

  return {
    calls,
    rows,
    listGrnHeaders: async () =>
      refnos.map((refno, i) => ({
        mmh_mrc_refno: refno,
        mmh_mrc_dt: "2026-09-17",
        supplier_name: "ACME",
        mmh_mrc_amt: 100 + i,
        product_count: 1,
      })),
    listGrnDetailByRefno: async (refno) =>
      refnos.includes(String(refno))
        ? { header: { mmh_mrc_refno: String(refno) }, items: [] }
        : null,
    listIgnoredGrnIssueKeysByRefno: async () => [],
    listGrnVerificationsByRefnos: async (keys) =>
      (keys || [])
        .map((k) => rows.get(String(k)))
        .filter(Boolean)
        .map((r) => ({ ...r })),
    getGrnVerificationByRefno: async (refno) => {
      const row = rows.get(String(refno));
      return row ? { ...row } : null;
    },
    insertGrnVerification: async (refno, verifiedBy) => {
      calls.inserts.push({ refno, verifiedBy });
      // The real repository rejects a missing verifier before it reaches the
      // NOT NULL column.
      if (verifiedBy == null || verifiedBy === "") {
        throw new Error("verified_by is required to verify a GRN");
      }
      // The unique key refusing the second approval, reported the way the
      // repository reports ER_DUP_ENTRY.
      if (rows.has(String(refno))) return { created: false };
      rows.set(String(refno), {
        mmh_mrc_refno: String(refno),
        verified_by: verifiedBy,
        verified_by_name: "Server Resolved Name",
        // The store's clock, as an instant - never the caller's, and never a
        // wall clock without a zone.
        verified_at: "2026-09-17T10:30:00Z",
      });
      return { created: true };
    },
  };
}

/** Records the guard each route was built with, and lets every call through. */
const tagging = {
  require: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { mode: "any", keys };
    return mw;
  },
  requireAll: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { mode: "all", keys };
    return mw;
  },
  has: async () => true,
};

/** A guard that actually refuses, the way `permissions.require` does. */
function enforcing(heldKeys) {
  const held = new Set(heldKeys);
  return {
    require: (...keys) => (req, res, next) => {
      if (!req.decoded) return res.status(401).json({ code: 401, msg: "Unauthorized" });
      if (keys.some((k) => held.has(k))) return next();
      return res.status(403).json({
        code: 403,
        msg: "You do not have permission to perform this action",
      });
    },
    requireAll: () => (req, res, next) => next(),
    has: async () => held.size > 0,
  };
}

/**
 * A FRESH copy of routes/grn.js per build.
 *
 * The module holds its Express router at module scope - every route file in
 * this repository does - so building the routes twice in one process would
 * append a second set of handlers to the SAME router, and a test would then
 * read the previous test's handler. Dropping the module from the require
 * cache gives each build its own router.
 */
function freshRoutes(usecase, permissions) {
  delete require.cache[require.resolve("./grn")];
  return require("./grn")(usecase, permissions);
}

function routesOf(usecase, permissions) {
  const out = [];
  for (const layer of freshRoutes(usecase, permissions).getRouter().stack) {
    if (!layer.route) continue;
    out.push({
      method: Object.keys(layer.route.methods)[0].toUpperCase(),
      path: layer.route.path,
      guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
      stack: layer.route.stack.map((s) => s.handle),
    });
  }
  return out;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  res.end = () => res;
  return res;
}

/** Runs a route's middleware chain and handler the way Express would. */
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

const verifyRouteOf = (usecase, permissions) =>
  routesOf(usecase, permissions).find(
    (r) => r.method === "POST" && r.path === "/:refno/verify"
  );

/* ------------------------------------------------------------- the tests */

describe("POST /grn/:refno/verify", () => {
  it("is guarded by verify_grn, and not by view_all_grn", () => {
    const route = verifyRouteOf(buildUsecase(fakeRepo()), tagging);

    assert.ok(route, "the verify route is registered");
    assert.deepEqual(route.guard, { mode: "any", keys: [P.VERIFY_GRN] });
    assert.equal(route.guard.keys.includes(P.VIEW_ALL_GRN), false);
  });

  it("refuses a caller who may view GRNs but not verify them", async () => {
    const route = verifyRouteOf(
      buildUsecase(fakeRepo()),
      enforcing([P.VIEW_ALL_GRN])
    );

    const res = await call(route, {
      params: { refno: "GRN-1" },
      body: {},
      decoded: { employee_id: 42, designation_id: 9 },
    });

    assert.equal(res.statusCode, 403);
  });

  it("lets a caller holding verify_grn through", async () => {
    const repo = fakeRepo();
    const route = verifyRouteOf(buildUsecase(repo), enforcing([P.VERIFY_GRN]));

    const res = await call(route, {
      params: { refno: "GRN-1" },
      body: {},
      decoded: { employee_id: 42, designation_id: 9 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.status, "VERIFIED");
  });

  it("captures the AUTHENTICATED user, ignoring any verified_by in the body", async () => {
    const repo = fakeRepo();
    const route = verifyRouteOf(buildUsecase(repo), tagging);

    const res = await call(route, {
      params: { refno: "GRN-1" },
      // A client trying to sign the GRN off as somebody else.
      body: { verified_by: 999, verified_at: "1999-01-01 00:00:00" },
      decoded: { employee_id: 42 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(repo.calls.inserts.length, 1);
    assert.equal(repo.calls.inserts[0].verifiedBy, 42);
    assert.equal(res.body.data.verified_by, 42);
    assert.notEqual(res.body.data.verified_by, 999);
  });

  it("never sends a caller-supplied timestamp to the store", async () => {
    const repo = fakeRepo();
    const seen = [];
    const inner = repo.insertGrnVerification;
    repo.insertGrnVerification = async (...args) => {
      seen.push(args);
      return inner(...args);
    };
    const route = verifyRouteOf(buildUsecase(repo), tagging);

    const res = await call(route, {
      params: { refno: "GRN-1" },
      body: { verified_at: "1999-01-01 00:00:00" },
      decoded: { employee_id: 42 },
    });

    // refno + employee id and nothing else: the column default writes the time.
    assert.deepEqual(seen, [["GRN-1", 42]]);
    assert.equal(res.body.data.verified_at, "2026-09-17T10:30:00Z");
  });

  it("does not overwrite the audit data when an already-verified GRN is clicked again", async () => {
    const repo = fakeRepo({
      verified: {
        mmh_mrc_refno: "GRN-1",
        verified_by: 7,
        verified_by_name: "First Verifier",
        verified_at: "2026-09-01T08:00:00Z",
      },
    });
    const route = verifyRouteOf(buildUsecase(repo), tagging);

    const res = await call(route, {
      params: { refno: "GRN-1" },
      body: {},
      decoded: { employee_id: 42 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.already_verified, true);
    assert.equal(res.body.data.verified_by, 7);
    assert.equal(res.body.data.verified_by_name, "First Verifier");
    assert.equal(res.body.data.verified_at, "2026-09-01T08:00:00Z");
    assert.deepEqual(repo.rows.get("GRN-1").verified_by, 7);
  });

  it("401s when the request carries no authenticated user", async () => {
    const route = verifyRouteOf(buildUsecase(fakeRepo()), tagging);

    const res = await call(route, {
      params: { refno: "GRN-1" },
      body: { verified_by: 5 },
      decoded: {},
    });

    assert.equal(res.statusCode, 401);
  });

  it("404s for a refno that is not a GRN", async () => {
    const repo = fakeRepo();
    const route = verifyRouteOf(buildUsecase(repo), tagging);

    const res = await call(route, {
      params: { refno: "NOPE" },
      body: {},
      decoded: { employee_id: 42 },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(repo.calls.inserts.length, 0);
  });

  it("propagates a NON-duplicate database error instead of calling it verified", async () => {
    const repo = fakeRepo();
    const boom = new Error("ER_NO_SUCH_TABLE: grn_verifications is missing");
    boom.code = "ER_NO_SUCH_TABLE";
    repo.insertGrnVerification = async () => {
      throw boom;
    };
    const route = verifyRouteOf(buildUsecase(repo), tagging);

    // `utils/http#respondError` asks global.isDev() whether to include the
    // message; the server sets it at boot and there is no server here.
    const hadIsDev = typeof global.isDev === "function";
    if (!hadIsDev) global.isDev = () => false;
    try {
      const res = await call(route, {
        params: { refno: "GRN-1" },
        body: {},
        decoded: { employee_id: 42 },
      });

      // 500, not a cheerful "already verified" over a broken table.
      assert.equal(res.statusCode, 500);
      assert.notEqual(res.body?.data?.status, "VERIFIED");
      assert.notEqual(res.body?.meta?.already_verified, true);
    } finally {
      if (!hadIsDev) delete global.isDev;
    }
  });

  it("reports a lost unique-key race as already_verified, with the winner's record", async () => {
    // Two approvals in flight: the second insert loses the unique key, and
    // the row it then reads is the FIRST verifier's.
    const repo = fakeRepo();
    const route = verifyRouteOf(buildUsecase(repo), tagging);

    const first = await call(route, {
      params: { refno: "GRN-1" },
      body: {},
      decoded: { employee_id: 7 },
    });
    const second = await call(route, {
      params: { refno: "GRN-1" },
      body: {},
      decoded: { employee_id: 42 },
    });

    assert.equal(first.body.meta.already_verified, false);
    assert.equal(first.body.data.verified_by, 7);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.meta.already_verified, true);
    assert.equal(second.body.data.verified_by, 7);
    assert.equal(repo.calls.inserts.length, 2, "the second insert was attempted");
  });

  it("writes nothing when the usecase is handed no verifier", async () => {
    // The route refuses this first; this is the usecase's own guard, which is
    // what stands between a future caller and a NOT NULL audit column.
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);

    await assert.rejects(
      () => usecase.verifyGrn("GRN-1", null),
      /verified_by is required/
    );
    assert.equal(repo.calls.inserts.length, 0);
  });
});

describe("verification state on the GRN list and detail", () => {
  it("reports an unverified GRN as PENDING", async () => {
    const usecase = buildUsecase(fakeRepo());

    const [header] = await usecase.listGrnHeaders({});
    const detail = await usecase.getGrnDetailByRefno("GRN-1");

    assert.deepEqual(header.verification, {
      status: "PENDING",
      verified_by: null,
      verified_by_name: null,
      verified_at: null,
    });
    assert.deepEqual(detail.verification, header.verification);
  });

  it("carries the verifier's display NAME so the grid needs no per-row lookup", async () => {
    const repo = fakeRepo({
      refnos: ["GRN-1", "GRN-2"],
      verified: {
        mmh_mrc_refno: "GRN-2",
        verified_by: 7,
        verified_by_name: "Asha R",
        verified_at: "2026-09-01T08:00:00Z",
      },
    });
    let batchCalls = 0;
    const inner = repo.listGrnVerificationsByRefnos;
    repo.listGrnVerificationsByRefnos = async (keys) => {
      batchCalls += 1;
      return inner(keys);
    };
    const usecase = buildUsecase(repo);

    const headers = await usecase.listGrnHeaders({});

    assert.equal(batchCalls, 1, "one batched lookup for the whole page");
    assert.equal(headers[0].verification.status, "PENDING");
    assert.deepEqual(headers[1].verification, {
      status: "VERIFIED",
      verified_by: 7,
      verified_by_name: "Asha R",
      verified_at: "2026-09-01T08:00:00Z",
    });
  });

  it("keeps the existing list and detail fields untouched", async () => {
    const usecase = buildUsecase(fakeRepo());

    const [header] = await usecase.listGrnHeaders({});
    const detail = await usecase.getGrnDetailByRefno("GRN-1");

    assert.equal(header.supplier_name, "ACME");
    assert.equal(header.product_count, 1);
    assert.deepEqual(detail.items, []);
    assert.equal(detail.header.mmh_mrc_refno, "GRN-1");
  });

  it("shows the detail payload of a verified GRN as VERIFIED", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);

    await usecase.verifyGrn("GRN-1", 42);
    const detail = await usecase.getGrnDetailByRefno("GRN-1");

    assert.equal(detail.verification.status, "VERIFIED");
    assert.equal(detail.verification.verified_by, 42);
    assert.equal(detail.verification.verified_at, "2026-09-17T10:30:00Z");
  });
});
