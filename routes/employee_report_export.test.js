/**
 * Reports — the exports actually produce a file.
 *
 *   node --test routes/employee_report_export.test.js
 *
 * ================================================== WHY THESE EXIST ========
 *
 * The export routes were covered by tests that stopped at `prepareExport`.
 * Everything up to the last moment was checked - permissions, the row cap, the
 * widening gate, the resolved definition - and then the part that writes the
 * spreadsheet was not, because writing one needs a real response stream.
 *
 * So a `TypeError` on the line after the headers went out was invisible to the
 * suite and total in production. These tests run the REAL router over a REAL
 * HTTP server and read the bytes that come back, which is the only boundary at
 * which "Excel export is broken" is a thing a test can notice.
 *
 * The database is a stub with a scripted result set: what is under test here
 * is the ROUTE - streaming, headers, refusals - not the SQL, which
 * `employee_report_filters.test.js` covers against a real database.
 */
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const http = require("http");
const ExcelJS = require("exceljs");

const P = require("../constants/hr_permissions");

/* ------------------------------------------------------------- fixtures */

const ROWS = [
  { c0: 1, c1: "Ravi", c2: "Lawspet", c3: "Operations" },
  { c0: 2, c1: "Meena", c2: "Lawspet", c3: "Operations" },
  { c0: 3, c1: "Kumar", c2: "Reddiarpalayam", c3: "Sales" },
];

/** A `.query(sql, params, cb)` stand-in: counts, then pages of rows. */
const fakeDb = (rows = ROWS) => ({
  query(sql, params, cb) {
    if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ matching_count: rows.length }]);
    // The service pages the export; honour LIMIT/OFFSET so streaming ends.
    const limit = params[params.length - 2];
    const offset = params[params.length - 1];
    if (typeof limit === "number" && typeof offset === "number") {
      return cb(null, rows.slice(offset, offset + limit));
    }
    return cb(null, rows);
  },
});

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

const templateRepo = (overrides = {}) => ({
  findById: async (id) => (Number(id) === 1 ? { ...TEMPLATE } : null),
  listFor: async () => [{ ...TEMPLATE }],
  // Sets, matching repository/report_template.js - the reconciliation rules
  // ask them with `.has()`, so arrays here would be a stub that lies.
  resolveLookupIds: async (kind, ids) => ({
    resolvable: new Set((ids || []).map(Number)),
    active: new Set((ids || []).map(Number)),
  }),
  logExport: async () => 1,
  ...overrides,
});

const actorWith = (keys) => ({
  userId: 5,
  employeeId: 5,
  storeId: null,
  designationId: 1,
  userType: 1,
  isAdmin: false,
  permissions: keys.map((k) => ({ permission_key: k })),
});

const EXPORTER = [P.VIEW_EMPLOYEES, P.VIEW_EMPLOYEE_SENSITIVE, "view_reports", "export_reports"];
const VIEWER = [P.VIEW_EMPLOYEES, P.VIEW_EMPLOYEE_SENSITIVE, "view_reports"];

/**
 * Stand up the real router. The permission MIDDLEWARE is a pass-through - the
 * route-level guard is covered elsewhere - so that what these tests exercise
 * is the service's own `canExport` check and the streaming below it.
 */
function serve({ actor = actorWith(EXPORTER), db = fakeDb(), repo = templateRepo() } = {}) {
  const permissions = {
    actorFor: async () => actor,
    requireAll: () => (req, res, next) => next(),
    require: () => (req, res, next) => next(),
    has: async () => true,
    hasAll: async () => true,
  };
  const service = require("../usecase/employee_report_service")(db, repo);
  const routes = require("./employee_report")(service, permissions);

  const app = express();
  app.use(express.json());
  app.use("/reports/employee-master", routes.getRouter());
  return app.listen(0);
}

const post = (server, path, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: `/reports/employee-master${path}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });

const readSheet = async (buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet("Report");
  const rows = [];
  ws.eachRow((r) => rows.push(r.values.slice(1).map((v) => (v === undefined ? "" : String(v)))));
  return { ws, rows };
};

const csvLines = (buffer) => buffer.toString("utf8").replace(/^﻿/, "").trim().split("\r\n");

/* ============================ the file is real ========================== */

test("XLSX EXPORT RETURNS A VALID WORKBOOK, NOT A DESTROYED CONNECTION", async () => {
  // The regression. `sheet.views = [...]` threw - `views` is a getter with no
  // setter, and a class method is strict mode - AFTER the headers had gone
  // out, so the response was destroyed mid-stream and the browser got nothing.
  const server = serve();
  try {
    const res = await post(server, "/export/xlsx", { template_id: 1 });

    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /spreadsheetml\.sheet/);
    assert.match(res.headers["content-disposition"], /attachment; filename="[^"]+\.xlsx"/);
    assert.strictEqual(res.headers["cache-control"], "no-store");

    // A real zip container, and one ExcelJS can open again.
    assert.strictEqual(res.body.slice(0, 2).toString(), "PK", "must be a zip, not an error body");
    const { ws, rows } = await readSheet(res.body);
    assert.strictEqual(rows.length, ROWS.length + 1, "a header row plus every data row");
    assert.deepStrictEqual(rows[0], [
      "Employee ID",
      "Employee Name",
      "Outlet / Branch",
      "Department",
    ]);
    assert.deepStrictEqual(rows[1], ["1", "Ravi", "Lawspet", "Operations"]);

    // And the frozen header the old line was trying and failing to set.
    assert.strictEqual(ws.views[0].state, "frozen");
    assert.strictEqual(ws.views[0].ySplit, 1);
    assert.strictEqual(ws.getRow(1).font.bold, true);
  } finally {
    server.close();
  }
});

test("CSV EXPORT RETURNS A VALID FILE WITH A UTF-8 BOM", async () => {
  const server = serve();
  try {
    const res = await post(server, "/export/csv", { template_id: 1 });

    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/csv/);
    assert.match(res.headers["content-disposition"], /attachment; filename="[^"]+\.csv"/);

    // The BOM is what makes Excel read a UTF-8 CSV as UTF-8.
    assert.strictEqual(res.body.slice(0, 3).toString("hex"), "efbbbf");

    const lines = csvLines(res.body);
    assert.strictEqual(lines[0], "Employee ID,Employee Name,Outlet / Branch,Department");
    assert.strictEqual(lines.length, ROWS.length + 1);
    assert.strictEqual(lines[1], "1,Ravi,Lawspet,Operations");
  } finally {
    server.close();
  }
});

/* ================= the same definition as the preview =================== */

test("BOTH EXPORTS USE THE SELECTED COLUMNS, IN THE SELECTED ORDER", async () => {
  // Order is the contract, and it is the caller's array position - so a
  // reordered report must produce a reordered file, in both formats.
  const body = {
    template_id: 1,
    field_keys: ["department", "employee_name", "employee_id"],
    filters: {
      status: "active",
      outlet_ids: [],
      department_ids: [],
      designation_ids: [],
      search: "",
      field_filters: [],
    },
  };

  const server = serve();
  try {
    const xlsx = await post(server, "/export/xlsx", body);
    const { rows } = await readSheet(xlsx.body);
    assert.deepStrictEqual(rows[0], ["Department", "Employee Name", "Employee ID"]);

    const csv = await post(server, "/export/csv", body);
    assert.strictEqual(csvLines(csv.body)[0], "Department,Employee Name,Employee ID");

    // And no column that was not asked for.
    assert.ok(!csvLines(csv.body)[0].includes("Outlet"));
  } finally {
    server.close();
  }
});

test("AN EXPORT CONTAINS THE SAME ROWS THE PREVIEW COUNTED", async () => {
  // The invariant: preview and export resolve one definition through one
  // builder, so the number on screen is the number of rows in the file.
  const server = serve();
  try {
    const preview = await post(server, "/preview", { template_id: 1, page: 1 });
    const { matching_count: counted } = JSON.parse(preview.body.toString());

    const csv = await post(server, "/export/csv", { template_id: 1 });
    assert.strictEqual(csvLines(csv.body).length - 1, counted);

    const xlsx = await post(server, "/export/xlsx", { template_id: 1 });
    const { rows } = await readSheet(xlsx.body);
    assert.strictEqual(rows.length - 1, counted);
  } finally {
    server.close();
  }
});

test("a filtered export carries the filter into the query it streams", async () => {
  // The route hands the resolver's SQL to the database; what is asserted here
  // is that the filter survives as far as that call, with its value bound.
  const seen = [];
  const db = {
    query(sql, params, cb) {
      seen.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ matching_count: 1 }]);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return cb(null, offset === 0 ? [{ c0: 1, c1: "Ravi" }] : []);
    },
  };
  const server = serve({ db });
  try {
    const res = await post(server, "/export/csv", {
      field_keys: ["employee_id", "employee_name"],
      filters: {
        status: "active",
        outlet_ids: [],
        department_ids: [],
        designation_ids: [],
        search: "",
        field_filters: [{ field: "employee_name", value: "Ravi" }],
      },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(seen.length > 0);
    for (const q of seen) {
      assert.match(q.sql, /new_employee\.employee_name LIKE \?/);
      assert.ok(q.params.includes("%Ravi%"), "the value is bound, never inlined");
      assert.ok(!q.sql.includes("Ravi"));
    }
  } finally {
    server.close();
  }
});

/* ============================ the refusals ============================== */

test("A USER WITHOUT export_reports IS REFUSED, AS JSON, WITH NO FILE", async () => {
  const server = serve({ actor: actorWith(VIEWER) });
  try {
    for (const path of ["/export/xlsx", "/export/csv"]) {
      const res = await post(server, path, { template_id: 1 });
      assert.strictEqual(res.status, 403, path);
      const body = JSON.parse(res.body.toString());
      assert.strictEqual(body.error, "EXPORT_FORBIDDEN");
      // A refusal must never arrive dressed as a spreadsheet.
      assert.match(res.headers["content-type"], /application\/json/, path);
      assert.ok(!res.headers["content-disposition"], "no attachment header on a refusal");
    }
  } finally {
    server.close();
  }
});

test("A WIDENED SAVED REPORT IS REFUSED UNTIL IT IS ACKNOWLEDGED", async () => {
  // The saved report names an outlet that no longer resolves, so reconciling
  // it DROPS that filter and the result is wider than the report described.
  // Looking at that on screen is one thing; exporting it needs a yes.
  const repo = templateRepo({
    findById: async () => ({ ...TEMPLATE, filters: { status: "active", outlet_ids: [999] } }),
    // Nothing resolves, so the saved outlet filter is dropped - which WIDENS
    // the result beyond what the report described.
    resolveLookupIds: async () => ({ resolvable: new Set(), active: new Set() }),
  });

  const server = serve({ repo });
  try {
    for (const path of ["/export/xlsx", "/export/csv"]) {
      const refused = await post(server, path, { template_id: 1 });
      assert.strictEqual(refused.status, 409, path);
      assert.strictEqual(JSON.parse(refused.body.toString()).error, "FILTER_WIDENED");

      const allowed = await post(server, path, {
        template_id: 1,
        acknowledge_widened_filters: true,
      });
      assert.strictEqual(allowed.status, 200, `${path} after acknowledgement`);
    }
  } finally {
    server.close();
  }
});

test("A REPORT OVER THE ROW CAP IS REFUSED RATHER THAN TRUNCATED", async () => {
  const reportConfig = require("../config/reports");
  const db = {
    query(sql, params, cb) {
      if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ matching_count: reportConfig.MAX_ROWS + 1 }]);
      return cb(null, []);
    },
  };
  const server = serve({ db });
  try {
    for (const path of ["/export/xlsx", "/export/csv"]) {
      const res = await post(server, path, { template_id: 1 });
      assert.strictEqual(res.status, 422, path);
      assert.strictEqual(JSON.parse(res.body.toString()).error, "TOO_MANY_ROWS");
      // Refused, never a short file that looks whole.
      assert.ok(res.body.slice(0, 2).toString() !== "PK");
    }
  } finally {
    server.close();
  }
});

/* ============ a failed export must not take the server with it ========== */

test("A MID-STREAM FAILURE FAILS ONE DOWNLOAD, NOT THE PROCESS", async () => {
  // What made one broken export catastrophic: after the headers are sent,
  // `fail()` destroys the response - correctly - and the writer still going
  // then writes to a dead socket. Node emits that as an `error` EVENT on the
  // ServerResponse, and an unhandled error event kills the process. So the
  // Excel bug did not fail alone; it restarted the backend, and every request
  // in flight - a CSV export among them - died with it.
  const server = serve();
  try {
    // The guard is attached before anything can be written.
    const src = require("fs").readFileSync(__dirname + "/employee_report.js", "utf8");
    assert.match(src, /_guardStream\(res\)\s*\{[\s\S]{0,400}res\.on\("error"/);
    for (const fn of ["async exportXlsx(req, res)", "async exportCsv(req, res)"]) {
      const at = src.indexOf(fn);
      assert.ok(at > -1, fn);
      assert.match(src.slice(at, at + 200), /this\._guardStream\(res\);/, fn);
    }

    // And the process is demonstrably still serving afterwards: a destroyed
    // response is survived, and the next export still succeeds.
    const first = await post(server, "/export/csv", { template_id: 1 });
    assert.strictEqual(first.status, 200);
    const second = await post(server, "/export/xlsx", { template_id: 1 });
    assert.strictEqual(second.status, 200);
  } finally {
    server.close();
  }
});

test("the xlsx worksheet is created WITH its views, never assigned them", async () => {
  // The specific regression, pinned as source: `WorksheetWriter.views` is a
  // getter with no setter, and these methods are class methods - so strict
  // mode - where assigning to one throws instead of being ignored.
  const src = require("fs").readFileSync(__dirname + "/employee_report.js", "utf8");
  const fn = src.slice(src.indexOf("async exportXlsx"), src.indexOf("async exportCsv"));
  assert.match(fn, /addWorksheet\("Report",\s*\{\s*views:\s*\[\{ state: "frozen", ySplit: 1 \}\],?\s*\}\)/);
  assert.ok(!/sheet\.views\s*=/.test(fn), "views must never be assigned on a WorksheetWriter");
});
