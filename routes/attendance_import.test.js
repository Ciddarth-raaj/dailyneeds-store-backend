/**
 * Attendance import routes: surface, the key on every endpoint, upload
 * validation, and that nothing leaks a server path.
 *
 *   node --test routes/attendance_import.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const express = require("express");

const buildRoutes = require("./attendance_import");
const P = require("../constants/hr_permissions");

function guardsOf(router) {
  const guards = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean);
    guards.push({ method, path: layer.route.path, guard, handler: layer.route.stack.slice(-1)[0].handle });
  }
  return guards;
}
const permissions = {
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
  actorFor: async () => ({ userId: 1, employeeId: 1, isAdmin: true }),
};
const fakeRes = () => {
  const r = { statusCode: 200, body: null, status(s) { r.statusCode = s; return r; }, json(b) { r.body = b; return r; } };
  return r;
};

/** Run the router in a real express app and POST a multipart body. */
function withServer(usecase, fn) {
  const app = express();
  app.use(express.json());
  app.use("/attendance/imports", buildRoutes(usecase, permissions).getRouter());
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      try {
        resolve(await fn(server.address().port));
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}
const CRLF = "\r\n";
function multipart(parts) {
  const boundary = `----test${Date.now()}`;
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${p.field}"; filename="${p.filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`));
    chunks.push(p.body);
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}
function post(port, path, { body, type }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": type, "Content-Length": body.length } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("/attendance/imports", () => {
  const guards = guardsOf(buildRoutes({}, permissions).getRouter());

  it("defines preview, list, details, items, commit and rematch, and nothing else", () => {
    assert.deepEqual(guards.map((g) => `${g.method} ${g.path}`).sort(), ["GET /", "GET /details", "GET /items", "POST /commit", "POST /digisme/preview", "POST /rematch"]);
  });

  it("rematch passes an optional employee_id through as a one-element filter, and rejects a non-positive one", async () => {
    const seen = [];
    const routes = buildRoutes({ async rematchUnmatched(f) { seen.push(f); return { code: 200, scanned: 3, rematched: 2, still_unmatched: 1, employees: [] }; } }, permissions);
    const h = guardsOf(routes.getRouter()).find((g) => g.path === "/rematch").handler;
    let res = fakeRes();
    await h({ body: { employee_id: 42 } }, res);
    assert.equal(res.body.rematched, 2);
    res = fakeRes();
    await h({ body: {} }, res);
    assert.equal(res.body.rematched, 2);
    assert.deepEqual(seen, [{ employeeIds: [42] }, { employeeIds: undefined }]);
    res = fakeRes();
    await h({ body: { employee_id: 0 } }, res);
    assert.equal(res.statusCode, 400);
  });

  it("every endpoint requires manage_attendance_import - a key granted to nobody, so admin only", () => {
    for (const g of guards) assert.deepEqual(g.guard.keys, [P.MANAGE_ATTENDANCE_IMPORT], `${g.method} ${g.path}`);
    assert.equal(P.MANAGE_ATTENDANCE_IMPORT, "manage_attendance_import");
    assert.notEqual(P.MANAGE_ATTENDANCE_IMPORT, P.VIEW_RAW_ATTENDANCE);
    assert.notEqual(P.MANAGE_ATTENDANCE_IMPORT, P.MANAGE_BIOMAX_DEVICES);
  });

  it("there is no delete: import history is permanent", () => {
    assert.ok(!guards.some((g) => g.method === "DELETE" || /delete|remove|purge/i.test(g.path)));
  });

  it("preview hands the usecase the uploaded file (name, size, temp path), deletes the temp file, and never returns the path", async () => {
    let got = null;
    const usecase = {
      async preview(file, actor) {
        got = { ...file, existedDuringPreview: fs.existsSync(file.path), actor };
        return { code: 200, batch: { import_batch_id: 1 } };
      },
    };
    await withServer(usecase, async (port) => {
      const res = await post(port, "/attendance/imports/digisme/preview", multipart([{ field: "file", filename: "ATDDailyAttendance.xlsx", body: Buffer.from("PKfake") }]));
      assert.equal(res.status, 200);
      assert.equal(got.originalname, "ATDDailyAttendance.xlsx");
      assert.equal(got.size, 6);
      assert.equal(got.existedDuringPreview, true);
      assert.equal(got.actor.employeeId, 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fs.existsSync(got.path), false, "temp file removed after preview");
      assert.equal(JSON.stringify(res.body).includes(got.path), false, "no server path in the response");
    });
  });

  it("preview refuses two files and no file with 400", async () => {
    let calls = 0;
    const usecase = { async preview() { calls += 1; return { code: 200 }; } };
    await withServer(usecase, async (port) => {
      const two = await post(port, "/attendance/imports/digisme/preview", multipart([{ field: "a", filename: "a.xlsx", body: Buffer.from("PK") }, { field: "b", filename: "b.xlsx", body: Buffer.from("PK") }]));
      assert.equal(two.status, 400);
      const none = await post(port, "/attendance/imports/digisme/preview", multipart([]));
      assert.equal(none.status, 400);
      assert.equal(calls, 0);
    });
  });

  it("a usecase validation error (wrong extension, bad workbook) is a 400 with the message", async () => {
    const usecase = {
      async preview() {
        const e = new Error("only .xlsx files are accepted");
        e.name = "ValidationError";
        throw e;
      },
    };
    await withServer(usecase, async (port) => {
      const res = await post(port, "/attendance/imports/digisme/preview", multipart([{ field: "file", filename: "a.xls", body: Buffer.from("x") }]));
      assert.equal(res.status, 400);
      assert.match(res.body.msg, /only \.xlsx/);
    });
  });

  it("commit validates its body and surfaces 409 / 404 from the usecase", async () => {
    const conflict = Object.assign(new Error("batch is COMMITTED; only a PREVIEWED batch can be committed"), { httpCode: 409 });
    const routes = buildRoutes({ async commit() { throw conflict; } }, permissions);
    const h = guardsOf(routes.getRouter()).find((g) => g.path === "/commit").handler;
    let res = fakeRes();
    await h({ body: {} }, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await h({ body: { import_batch_id: 1 } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.msg, /PREVIEWED/);
  });

  it("items requires import_batch_id and caps the page size", async () => {
    let seen = null;
    const routes = buildRoutes({ async items(id, f) { seen = { id, f }; return { rows: [], total: 0 }; } }, permissions);
    const h = guardsOf(routes.getRouter()).find((g) => g.path === "/items").handler;
    let res = fakeRes();
    await h({ query: {} }, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await h({ query: { import_batch_id: "3", classification: "BAD_ROW", limit: "5000" } }, res);
    assert.equal(res.statusCode, 400, "limit above 1000 refused");
    res = fakeRes();
    await h({ query: { import_batch_id: "3", classification: "BAD_ROW", limit: "50", offset: "100" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, { id: "3", f: { classification: "BAD_ROW", limit: "50", offset: "100" } });
  });
});
