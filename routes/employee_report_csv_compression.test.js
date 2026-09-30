/**
 * Employee Report CSV export, over real HTTP, through the app-wide
 * `compression` middleware exactly as server.js mounts it.
 *
 *   node --test routes/employee_report_csv_compression.test.js
 *
 * THE BUG THIS PINS. `compression` replaces `res.write(chunk, encoding)` and,
 * when it gzips, never calls a callback passed there. The CSV export awaited
 * that callback for every page of rows, so every browser download (browsers
 * always send Accept-Encoding: gzip) stalled after the header until the 60 s
 * EXPORT_TIMEOUT_MS destroyed it. The same defect was fixed in the Attendance
 * CSV (routes/attendance_raw.js); routes/employee_report_export.test.js never
 * saw it because it mounts no compression and asks for no encoding.
 *
 * Everything on the request path is real: the permission middleware, the
 * employee branch scope, the report service and resolver, and the route. Only
 * the database is a fake that records what it was asked.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const zlib = require("zlib");
const express = require("express");
const compression = require("compression");

const P = require("../constants/hr_permissions");
const reportConfig = require("../config/reports");
const buildPermissions = require("../middlewares/permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");

const BROWSER = "gzip, deflate, br";
const HEADER = ["Employee ID", "Employee Name", "Outlet / Branch", "Department"];

/* ------------------------------------------------------------- fixtures */

const ALL_BRANCHES = 21; // may export, company-wide
const OWN_BRANCH = 22; //   may export, own branch only
const VIEWER = 23; //       may view reports, may not export

const EXPORT_KEYS = [P.VIEW_REPORTS, P.VIEW_EMPLOYEES, P.EXPORT_REPORTS, P.VIEW_EMPLOYEE_SENSITIVE];
const DESIGNATIONS = {
  [ALL_BRANCHES]: [...EXPORT_KEYS, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [OWN_BRANCH]: EXPORT_KEYS,
  [VIEWER]: [P.VIEW_REPORTS, P.VIEW_EMPLOYEES, P.VIEW_EMPLOYEE_SENSITIVE],
};
const ACTOR_EMPLOYEE_ID = 5;
const ACTOR_STORE_ID = 7;

const TEMPLATE = {
  template_id: 1,
  template_name: "Active Employee List",
  dataset_key: "EMPLOYEE_MASTER",
  field_keys: ["employee_id", "employee_name", "outlet", "department"],
  filters: { status: "active" },
  owner_user_id: null,
  is_shared: 1,
  is_system: 1,
};

const row = (id, name, outlet = "Lawspet", department = "Operations") => ({ c0: id, c1: name, c2: outlet, c3: department });

/** The awkward cells, one of each kind the CSV must survive. */
const AWKWARD = [
  row(1, "முருகன் செல்வம்", "தி.நகர் கிளை", "பில்லிங்"),
  row(2, "Kumar, Ravi", "Lawspet"),
  row(3, 'Meena "MK" K', "Lawspet"),
  row(4, "Line one\nLine two", "Reddiarpalayam"),
  row(5, "=HYPERLINK(\"http://x\")", "+91 Branch", "-Ops"),
  row(6, "@SUM(A1)", "Lawspet"),
];

const many = (n, width = 0) =>
  Array.from({ length: n }, (_, i) =>
    row(i + 1, `Employee ${i + 1} பெயர்${width ? ` ${crypto.randomBytes(width).toString("base64")}` : ""}`)
  );

/**
 * A `.query(sql, params, cb)` stand-in: a count, then pages by LIMIT/OFFSET.
 * `failAtOffset` makes one page an error, as a dropped database would.
 */
function fakeDb(rows, { failAtOffset = null, pageDelayMs = 0 } = {}) {
  const seen = [];
  return {
    seen,
    query(sql, params, cb) {
      seen.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ matching_count: rows.length }]);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const answer = () =>
        failAtOffset !== null && offset === failAtOffset
          ? cb(new Error("connection lost"))
          : cb(null, rows.slice(offset, offset + limit));
      if (pageDelayMs) setTimeout(answer, pageDelayMs);
      else answer();
    },
  };
}

/** Serve the REAL route through compression; `as` picks the caller's designation. */
function serve({ rows = AWKWARD, db = fakeDb(rows), as = ALL_BRANCHES } = {}) {
  const exports = [];
  const repo = {
    findById: async (id) => (Number(id) === 1 ? { ...TEMPLATE } : null),
    listFor: async () => [{ ...TEMPLATE }],
    resolveLookupIds: async (kind, ids) => ({
      resolvable: new Set((ids || []).map(Number)),
      active: new Set((ids || []).map(Number)),
    }),
    logExport: async (entry) => {
      exports.push(entry);
      return exports.length;
    },
  };
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (DESIGNATIONS[designationId] || []).map((permission_key) => ({ permission_key })),
  });
  const branchScope = buildScopeFor(permissions, [
    { employee_id: ACTOR_EMPLOYEE_ID, store_id: ACTOR_STORE_ID, status: 1 },
  ]);
  const service = require("../usecase/employee_report_service")(db, repo);
  const routes = require("./employee_report")(service, permissions, branchScope);

  // Observe when the handler itself returns, so a stalled or abandoned export
  // is visible from the server side and not only from the client's.
  const handler = { finishedAt: null };
  const exportCsv = routes.exportCsv.bind(routes);
  routes.exportCsv = async (req, res) => {
    await exportCsv(req, res);
    handler.finishedAt = Date.now();
  };

  const app = express();
  app.use((req, res, next) => {
    // What middlewares/auth.js leaves on an authenticated request.
    req.decoded = { user_type: 1, designation_id: as, user_id: 50, employee_id: ACTOR_EMPLOYEE_ID };
    req.auth = { employeeId: ACTOR_EMPLOYEE_ID };
    next();
  });
  app.use(compression());
  // After compression, so this sees what the route sees: compression's own
  // write(). A `false` here is the backpressure signal the route must honour.
  const writes = { total: 0, refused: 0 };
  app.use((req, res, next) => {
    const write = res.write;
    res.write = function spied(...args) {
      const ok = write.apply(this, args);
      writes.total += 1;
      if (!ok) writes.refused += 1;
      return ok;
    };
    next();
  });
  app.use(express.json());
  app.use("/reports/employee-master", routes.getRouter());
  const server = app.listen(0);
  return { server, db, exports, handler, writes };
}

function decode(res, body) {
  const enc = res.headers["content-encoding"];
  if (enc === "gzip") return zlib.gunzipSync(body);
  if (enc === "deflate") return zlib.inflateSync(body);
  if (enc === "br") return zlib.brotliDecompressSync(body);
  return body;
}

/**
 * POST like the browser does. Rejects on a stall rather than hanging the run;
 * `pauseMs` is a slow reader, `abortAfterMs` a user who closes the tab.
 */
function post(server, body, { encoding = BROWSER, pauseMs = 0, abortAfterMs = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: "/reports/employee-master/export/csv",
        method: "POST",
        headers: {
          "accept-encoding": encoding,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        if (pauseMs) {
          res.pause();
          setTimeout(() => res.resume(), pauseMs);
        }
        if (abortAfterMs !== null) res.pause();
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (abandoned) return;
          if (!res.complete) {
            resolve({ status: res.statusCode, incomplete: true });
            return;
          }
          const raw = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, raw, text: decode(res, raw).toString("utf8") });
        });
        res.on("error", (err) => resolve({ status: res.statusCode, incomplete: true, error: err.code }));
      }
    );
    req.on("error", (err) => {
      if (abortAfterMs === null) resolve({ incomplete: true, error: err.code });
    });
    // The user closes the tab this long after clicking - timed from the
    // request, not the response: compression holds output back until it has
    // enough to emit, so headers can arrive late.
    let abandoned = false;
    if (abortAfterMs !== null) {
      setTimeout(() => {
        abandoned = true;
        req.destroy();
        resolve({ aborted: true, abortedAt: Date.now() });
      }, abortAfterMs);
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`no complete response within ${timeoutMs} ms - the export stalled`));
    });
    req.end(payload);
  });
}

/** RFC 4180, the way a spreadsheet reads the file. */
function parseCsv(text) {
  const rows = [];
  let cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { cells.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { cells.push(cell); rows.push(cells); cells = []; cell = ""; i += 1; }
    else cell += c;
  }
  if (cell !== "" || cells.length) { cells.push(cell); rows.push(cells); }
  return rows;
}

const csvOf = (res) => {
  assert.ok(res.text.startsWith("﻿"), "UTF-8 BOM first, so Excel reads Tamil as UTF-8");
  return parseCsv(res.text.slice(1));
};

const waitFor = async (predicate, ms) => {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return predicate();
};

/* ================================================================ tests */

describe("POST /reports/employee-master/export/csv through compression", () => {
  it("1. completes gzip-compressed, with the download headers intact", async () => {
    const { server, exports } = serve();
    try {
      const res = await post(server, { template_id: 1 }, { encoding: "gzip, deflate" });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], "gzip");
      assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
      assert.match(res.headers["content-disposition"], /^attachment; filename="Active-Employee-List-\d{4}-\d{2}-\d{2}\.csv"$/);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(csvOf(res).length, 1 + AWKWARD.length);
      assert.equal(exports.length, 1);
    } finally {
      server.close();
    }
  });

  it("2. completes brotli-compressed, which is what a browser offering br gets", async () => {
    const { server } = serve();
    try {
      const res = await post(server, { template_id: 1 }, { encoding: BROWSER });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], "br");
      assert.equal(csvOf(res).length, 1 + AWKWARD.length);
    } finally {
      server.close();
    }
  });

  it("3. completes uncompressed, byte for byte the same file", async () => {
    const { server } = serve();
    try {
      const plain = await post(server, { template_id: 1 }, { encoding: "identity" });
      const gz = await post(server, { template_id: 1 }, { encoding: "gzip" });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers["content-encoding"], undefined);
      assert.equal(plain.text, gz.text);
    } finally {
      server.close();
    }
  });

  it("4. streams several pages of rows and the file holds every one, in order", async () => {
    const rows = many(reportConfig.STREAM_CHUNK * 2 + 37);
    const { server, db, exports } = serve({ rows });
    try {
      const res = await post(server, { template_id: 1 });
      assert.equal(res.status, 200);
      const pages = db.seen.filter((q) => /LIMIT \? OFFSET \?/.test(q.sql));
      assert.equal(pages.length, 3, "three pages through streamRows");
      const csv = csvOf(res);
      assert.deepEqual(csv[0], HEADER);
      assert.equal(csv.length - 1, rows.length);
      assert.deepEqual(csv.slice(1).map((r) => Number(r[0])), rows.map((r) => r.c0));
      assert.equal(exports[0].row_count, rows.length);
    } finally {
      server.close();
    }
  });

  it("5. backpressure: compression refuses writes, the export waits for drain, a slow reader gets it all", async () => {
    // ~5 MB of poorly compressible text in 500-row pages: each page is far
    // over the zlib stream's buffer, so compression's write() returns false
    // and the route must wait for `drain` - the path the old callback code
    // never got past. (Whether the paused CLIENT is what holds it depends on
    // the kernel's loopback buffers, so that is not what is asserted.)
    const rows = many(reportConfig.MAX_ROWS, 700);
    const { server, exports, writes } = serve({ rows });
    try {
      const res = await post(server, { template_id: 1 }, { pauseMs: 500, timeoutMs: 30000 });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], "br");
      assert.ok(writes.refused > 0, `compression refused ${writes.refused} of ${writes.total} writes`);
      const csv = csvOf(res);
      assert.equal(csv.length - 1, rows.length);
      assert.equal(csv.at(-1)[1], rows.at(-1).c1);
      assert.equal(exports.length, 1);
      assert.equal(exports[0].row_count, rows.length);
    } finally {
      server.close();
    }
  });

  it("6 & 16. a client that disconnects mid-stream frees the handler at once and is NOT audited", async () => {
    // Ten pages at 100 ms each - a real database is not instant - so the
    // user closes the tab while the export is genuinely still running.
    const rows = many(reportConfig.MAX_ROWS);
    const db = fakeDb(rows, { pageDelayMs: 100 });
    const { server, exports, handler } = serve({ rows, db });
    try {
      const res = await post(server, { template_id: 1 }, { abortAfterMs: 250, timeoutMs: 30000 });
      assert.equal(res.aborted, true);
      assert.ok(await waitFor(() => handler.finishedAt !== null, 2000), "handler returned after the disconnect");
      assert.ok(handler.finishedAt - res.abortedAt < 2000, `handler returned ${handler.finishedAt - res.abortedAt} ms after the disconnect`);
      assert.equal(exports.length, 0, "an abandoned download is not recorded as an export");
      const pages = db.seen.filter((q) => /LIMIT \? OFFSET \?/.test(q.sql)).length;
      assert.ok(pages < rows.length / reportConfig.STREAM_CHUNK, `stopped paging after ${pages} page(s)`);
    } finally {
      server.close();
    }
  });

  it("16. a database failure mid-stream destroys the download and is NOT audited", async () => {
    const rows = many(reportConfig.STREAM_CHUNK * 3);
    const db = fakeDb(rows, { failAtOffset: reportConfig.STREAM_CHUNK });
    const { server, exports, handler } = serve({ rows, db });
    try {
      const res = await post(server, { template_id: 1 });
      assert.ok(res.incomplete, "never a short file that looks whole");
      assert.ok(await waitFor(() => handler.finishedAt !== null, 2000));
      assert.equal(exports.length, 0);
    } finally {
      server.close();
    }
  });

  it("7. a zero-row export is a header-only file, audited with row_count 0", async () => {
    const { server, exports } = serve({ rows: [] });
    try {
      const res = await post(server, { template_id: 1 });
      assert.equal(res.status, 200);
      assert.deepEqual(csvOf(res), [HEADER]);
      assert.equal(exports.length, 1);
      assert.equal(exports[0].row_count, 0);
    } finally {
      server.close();
    }
  });

  it("8-12. Tamil intact; commas, quotes and newlines escaped; formulas neutralised", async () => {
    const { server } = serve();
    try {
      const res = await post(server, { template_id: 1 });
      const csv = csvOf(res);
      assert.equal(csv.length, 1 + AWKWARD.length, "an embedded newline did not split a row");
      for (const r of csv) assert.equal(r.length, HEADER.length);
      const byId = Object.fromEntries(csv.slice(1).map((r) => [r[0], r]));
      assert.deepEqual(byId["1"].slice(1), ["முருகன் செல்வம்", "தி.நகர் கிளை", "பில்லிங்"]);
      assert.equal(byId["2"][1], "Kumar, Ravi");
      assert.equal(byId["3"][1], 'Meena "MK" K');
      assert.equal(byId["4"][1], "Line one\nLine two");
      assert.deepEqual(byId["5"].slice(1), ["'=HYPERLINK(\"http://x\")", "'+91 Branch", "'-Ops"]);
      assert.equal(byId["6"][1], "'@SUM(A1)");
      // And on the wire, the RFC 4180 quoting itself.
      assert.ok(res.text.includes('"Kumar, Ravi"'));
      assert.ok(res.text.includes('"Meena ""MK"" K"'));
      assert.ok(res.text.includes('"Line one\nLine two"'));
    } finally {
      server.close();
    }
  });

  it("13. a branch-scoped caller's export is restricted to their branch in the streamed query", async () => {
    const { server, db, exports } = serve({ as: OWN_BRANCH });
    try {
      const res = await post(server, { template_id: 1 });
      assert.equal(res.status, 200);
      const pages = db.seen.filter((q) => /LIMIT \? OFFSET \?/.test(q.sql));
      assert.ok(pages.length > 0);
      for (const q of pages) {
        assert.match(q.sql, /new_employee\.store_id IN \(\?\)/);
        assert.ok(q.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === ACTOR_STORE_ID));
      }
      assert.equal(exports[0].employee_id, ACTOR_EMPLOYEE_ID);

      // The company-wide caller's query carries no branch predicate.
      const wide = serve({ as: ALL_BRANCHES });
      try {
        await post(wide.server, { template_id: 1 });
        for (const q of wide.db.seen) assert.doesNotMatch(q.sql, /store_id IN \(\?\)/);
      } finally {
        wide.server.close();
      }
    } finally {
      server.close();
    }
  });

  it("14. a caller without export_reports is refused as JSON, before any CSV, and nothing is audited", async () => {
    const { server, db, exports } = serve({ as: VIEWER });
    try {
      const res = await post(server, { template_id: 1 });
      assert.equal(res.status, 403);
      assert.match(res.headers["content-type"], /application\/json/);
      assert.equal(res.headers["content-disposition"], undefined);
      assert.equal(db.seen.length, 0, "no query ran");
      assert.equal(exports.length, 0);
    } finally {
      server.close();
    }
  });

  it("15. a successful export is audited once, with the row count actually written", async () => {
    const rows = many(1234);
    const { server, exports } = serve({ rows });
    try {
      const res = await post(server, { template_id: 1 });
      assert.equal(csvOf(res).length - 1, 1234);
      assert.equal(exports.length, 1);
      assert.equal(exports[0].row_count, 1234);
      assert.equal(exports[0].format, "csv");
    } finally {
      server.close();
    }
  });
});
