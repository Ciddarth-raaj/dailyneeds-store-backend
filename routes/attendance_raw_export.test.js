/**
 * Attendance List and Punch Audit CSV exports, over real HTTP, through the
 * app-wide `compression` middleware exactly as server.js mounts it.
 *
 *   node --test routes/attendance_raw_export.test.js
 *
 * THE BUG THIS PINS. `compression` replaces `res.write(chunk, encoding)` and,
 * when it gzips, never calls a callback passed there. The export awaited that
 * callback for backpressure, so every browser download (browsers always send
 * Accept-Encoding: gzip) stalled after the header row until the 60 s timer
 * destroyed it. Every request below asks for gzip.
 *
 * The usecase is the real one over a fake repository, so the CSV is checked
 * against the same `list()` the screen reads: same filters, same row count,
 * punches in order, nothing calculated.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const zlib = require("zlib");
const express = require("express");
const compression = require("compression");

const buildRoutes = require("./attendance_raw");
const buildUsecase = require("../usecase/attendance_raw");

const permissions = {
  require: () => (req, res, next) => next(),
  actorFor: async () => ({ userId: 1, employeeId: 1 }),
};

/** One raw punch row as repository/biomax_punch listDated() returns it. */
function punch(id, employee, date, time, outlet = { id: 1, name: "Adyar", code: "ADY" }, extra = {}) {
  return {
    biomax_punch_id: id,
    dev_id: "CLOUD1",
    user_id: employee.code,
    io_time: `${date} ${time}`,
    clock_time: time.slice(0, 5),
    calendar_date: date,
    attendance_date: date,
    derivation_status: "DATED",
    employee_id: employee.id,
    employee_name: employee.name,
    employee_status: 1,
    department_name: employee.department,
    home_outlet_id: employee.home_outlet_id,
    home_outlet: employee.home_outlet,
    home_outlet_code: "H",
    device_label: "Front",
    punch_outlet_id: outlet.id,
    punch_outlet: outlet.name,
    punch_outlet_code: outlet.code,
    device_status: "REGISTERED",
    ingest_source: "BIOMAX",
    ...extra,
  };
}

const ONE = { id: 1, code: "E001", name: "Ravi", department: "Stores", home_outlet_id: 10, home_outlet: "Adyar" };
const THREE = { id: 2, code: "E002", name: "முருகன் செல்வம்", department: "Billing", home_outlet_id: 11, home_outlet: "தி.நகர்" };
const SIX = { id: 3, code: "E003", name: 'Kumar, "KK"\nJr', department: "=cmd", home_outlet_id: 10, home_outlet: "Adyar" };
const TNAGAR = { id: 2, name: "தி.நகர் கிளை", code: null };

const SAMPLE = [
  punch(1, ONE, "2026-09-01", "09:02:00"),
  punch(2, THREE, "2026-09-01", "08:55:00", TNAGAR),
  punch(3, THREE, "2026-09-01", "13:00:00"),
  punch(4, THREE, "2026-09-01", "18:01:00", TNAGAR),
  ...["07:00", "09:00", "11:00", "13:00", "15:00", "17:00"].map((t, i) => punch(10 + i, SIX, "2026-09-01", `${t}:00`)),
  punch(20, ONE, "2026-09-02", "09:10:00"),
  punch(21, ONE, "2026-09-02", "10:00:00", undefined, { device_status: "UNREGISTERED_DEVICE" }),
];

function fakeRepo(rows) {
  const calls = [];
  return {
    calls,
    async listDated(filters) {
      calls.push(filters);
      return typeof rows === "function" ? rows(filters) : rows;
    },
    async summary() {
      return { groups: [], unregistered: [] };
    },
    async listPunches() {
      return rows;
    },
  };
}

/** RFC 4180 parser, so the test reads the file the way a spreadsheet does. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 1; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

let server;
let port;
let repo;
let exportLog;

function startApp() {
  const app = express();
  app.use(compression());
  exportLog = { entries: [], async logExport(e) { this.entries.push(e); } };
  app.use("/attendance", buildRoutes(buildUsecase({
    listDated: (f) => repo.listDated(f),
    summary: (f) => repo.summary(f),
    listPunches: (f) => repo.listPunches(f),
  }, exportLog), permissions).getRouter());
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
}

/** GET with gzip, as a browser does; decode and fail on a stall. */
function get(path, { encoding = "gzip, deflate", timeoutMs = 10000, pauseMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, headers: { "accept-encoding": encoding } }, (res) => {
      const bufs = [];
      if (pauseMs) {
        res.pause();
        setTimeout(() => res.resume(), pauseMs);
      }
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => {
        let body = Buffer.concat(bufs);
        if (res.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
        else if (res.headers["content-encoding"] === "deflate") body = zlib.inflateSync(body);
        else if (res.headers["content-encoding"] === "br") body = zlib.brotliDecompressSync(body);
        resolve({ status: res.statusCode, headers: res.headers, body: body.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`no complete response for ${path} within ${timeoutMs} ms - the export stalled`));
    });
  });
}

const q = (params) => new URLSearchParams(params).toString();
const listUsecase = () => buildUsecase(fakeRepo(SAMPLE));

describe("GET /attendance/raw/export.csv through compression", () => {
  before(startApp);
  after(() => server.close());

  it("completes with gzip (the production failure) and sends download headers", async () => {
    repo = fakeRepo(SAMPLE);
    const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-02" })}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
    assert.equal(res.headers["content-encoding"], "gzip");
    assert.equal(res.headers["content-disposition"], 'attachment; filename="attendance-list-2026-09-01-to-2026-09-02.csv"');
    assert.ok(res.body.startsWith("﻿"), "UTF-8 BOM so Excel reads Tamil as UTF-8");
  });

  it("also completes uncompressed and with brotli", async () => {
    repo = fakeRepo(SAMPLE);
    for (const encoding of ["identity", "br"]) {
      const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-02" })}`, { encoding });
      assert.equal(res.status, 200, encoding);
      assert.equal(parseCsv(res.body.slice(1)).length, 5, encoding);
    }
  });

  it("one row per employee per date, punches in order, 1 / 3 / 6 punches, row count equals the screen", async () => {
    repo = fakeRepo(SAMPLE);
    const query = { from: "2026-09-01", to: "2026-09-02" };
    const res = await get(`/attendance/raw/export.csv?${q(query)}`);
    const rows = parseCsv(res.body.slice(1));
    const header = rows.shift();
    assert.deepEqual(header, [
      "Employee Code", "Employee Name", "Department", "Home Outlet", "Clock Date",
      "Clock Time-1", "Clock Time-2", "Clock Time-3", "Clock Time-4", "Clock Time-5", "Clock Time-6",
      "Punches", "Quarantined",
    ]);
    const screen = await listUsecase().list(query);
    assert.equal(rows.length, screen.meta.row_count);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], ["E001", "Ravi", "Stores", "Adyar", "01/09/2026", "09:02", "", "", "", "", "", "1", "0"]);
    assert.deepEqual(rows[1].slice(5, 13), ["08:55", "13:00", "18:01", "", "", "", "3", "0"]);
    assert.deepEqual(rows[2].slice(5, 13), ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "6", "0"]);
    // The unregistered-device punch is counted, not shown - as on the screen.
    assert.deepEqual(rows[3], ["E001", "Ravi", "Stores", "Adyar", "02/09/2026", "09:10", "", "", "", "", "", "1", "1"]);
  });

  it("escapes commas, quotes and line breaks, neutralises formulas, keeps Tamil intact", async () => {
    repo = fakeRepo(SAMPLE);
    const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-02" })}`);
    const rows = parseCsv(res.body.slice(1));
    const [header, , tamil, awkward] = rows;
    assert.equal(rows.length, 5, "an embedded line break did not split a row");
    assert.equal(awkward.length, header.length);
    assert.deepEqual(awkward.slice(0, 4), ["E003", 'Kumar, "KK"\nJr', "'=cmd", "Adyar"]);
    assert.deepEqual(tamil.slice(0, 4), ["E002", "முருகன் செல்வம்", "Billing", "தி.நகர்"]);
  });

  it("with_locations=1: same rows, each time followed by its punch location", async () => {
    repo = fakeRepo(SAMPLE);
    const plain = parseCsv((await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-02" })}`)).body.slice(1));
    const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-02", with_locations: 1 })}`);
    assert.equal(res.status, 200);
    const rows = parseCsv(res.body.slice(1));
    assert.deepEqual(rows[0], plain[0]);
    assert.equal(rows.length, plain.length);
    assert.deepEqual(rows[1].slice(0, 5), plain[1].slice(0, 5));
    assert.deepEqual(rows[2].slice(5, 8), ["08:55 @தி.நகர் கிளை", "13:00 @ADY", "18:01 @தி.நகர் கிளை"]);
    assert.equal(rows[1][5], "09:02 @ADY");
  });

  it("passes the screen's filters to the same query: outlet, department, employee search, date range", async () => {
    repo = fakeRepo(SAMPLE);
    await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-30", home_outlet_id: 11, department_id: 4, search: "முருகன்" })}`);
    assert.deepEqual(repo.calls.at(-1), { from: "2026-09-01", to: "2026-09-30", home_outlet_id: 11, department_id: 4, search: "முருகன்" });
  });

  it("an empty result is a header-only CSV, not an error", async () => {
    repo = fakeRepo([]);
    const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-30", to: "2026-09-30" })}`);
    assert.equal(res.status, 200);
    assert.deepEqual(parseCsv(res.body.slice(1)), [["Employee Code", "Employee Name", "Department", "Home Outlet", "Clock Date", "Punches", "Quarantined"]]);
  });

  it("a large month to a slow reader completes in full (backpressure waits, then resumes)", async () => {
    // 500 employees x 30 days x 4 punches = 15,000 rows, 30 chunks.
    const big = [];
    let id = 0;
    for (let d = 1; d <= 30; d += 1) {
      const date = `2026-09-${String(d).padStart(2, "0")}`;
      for (let e = 1; e <= 500; e += 1) {
        const emp = { id: e, code: `E${e}`, name: `Employee ${e} பெயர்`, department: "Stores", home_outlet_id: 10, home_outlet: "Adyar" };
        for (const t of ["08:00:00", "12:00:00", "13:00:00", "17:00:00"]) big.push(punch((id += 1), emp, date, t));
      }
    }
    repo = fakeRepo(big);
    const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-30" })}`, { pauseMs: 300, timeoutMs: 20000 });
    assert.equal(res.status, 200);
    const rows = parseCsv(res.body.slice(1));
    assert.equal(rows.length - 1, 15000);
    assert.deepEqual(rows.at(-1), ["E500", "Employee 500 பெயர்", "Stores", "Adyar", "30/09/2026", "08:00", "12:00", "13:00", "17:00", "4", "0"]);
    assert.equal(exportLog.entries.at(-1).row_count, 15000);
  });

  it("a refusal is still JSON with its status, before any CSV byte", async () => {
    repo = fakeRepo(SAMPLE);
    const res = await get(`/attendance/raw/export.csv?${q({ from: "2026-09-01", to: "2026-09-01", dev_id: "X" })}`);
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).msg, /Punch Audit/);
  });

  it("the Punch Audit CSV, which shares the streamer, completes with gzip too", async () => {
    repo = fakeRepo(SAMPLE);
    const res = await get(`/attendance/raw/punches/export.csv?${q({ from: "2026-09-01", to: "2026-09-02" })}`);
    assert.equal(res.status, 200);
    assert.equal(parseCsv(res.body.slice(1)).length - 1, SAMPLE.length);
  });
});
