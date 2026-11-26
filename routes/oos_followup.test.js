/**
 * /oos-followup routes: permission gates and upload validation.
 *
 *   node --test routes/oos_followup.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

// Permissions from a test header: x-perms "a,b", employee from x-emp.
const permsOf = (req) => new Set(String(req.headers["x-perms"] || "").split(",").filter(Boolean));
const permissions = {
  has: async (req, ...keys) => keys.some((k) => permsOf(req).has(k)),
  require: (...keys) => (req, res, next) => (keys.some((k) => permsOf(req).has(k)) ? next() : res.status(403).json({ code: 403 })),
};
const calls = [];
const usecase = {
  upload: async (a) => (calls.push(["upload", a]), { code: 200 }),
  view: async (a) => (calls.push(["view", a]), { code: 200, data: {} }),
  answer: async (a) => (calls.push(["answer", a]), { code: 200 }),
  events: async (a) => (calls.push(["events", a]), { code: 200, data: [] }),
};

describe("/oos-followup", () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => ((req.decoded = { employee_id: Number(req.headers["x-emp"]) || null }), next()));
    app.use("/oos-followup", require("./oos_followup")(usecase, permissions).getRouter());
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const call = (method, path, perms, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-perms": perms, "x-emp": "8" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });

  it("upload needs upload_oos_report and valid rows", async () => {
    const rows = [{ article_id: 103539, store: "ecr", value: "12.5", class: "A" }];
    assert.equal((await call("POST", "/oos-followup/upload", "chase_oos", { rows })).status, 403);
    assert.equal((await call("POST", "/oos-followup/upload", "upload_oos_report", { rows: [] })).status, 400);
    assert.equal((await call("POST", "/oos-followup/upload", "upload_oos_report", { rows: [{ bogus: 1 }] })).status, 400);
    const ok = await call("POST", "/oos-followup/upload", "upload_oos_report", { rows, file_name: "out_supplier_2026-11-26.csv" });
    assert.equal(ok.status, 200);
    assert.equal(calls.at(-1)[1].employeeId, 8);
  });

  it("the view: chaser or buyer; the chaser flag and buyer filter reach the usecase", async () => {
    assert.equal((await call("GET", "/oos-followup", "upload_oos_report")).status, 403);
    await call("GET", "/oos-followup?buyer_id=none", "chase_oos");
    assert.deepEqual([calls.at(-1)[1].canChase, calls.at(-1)[1].buyerId], [true, "none"]);
    await call("GET", "/oos-followup?buyer_id=7", "view_my_oos");
    assert.deepEqual([calls.at(-1)[1].canChase, calls.at(-1)[1].employeeId], [false, 8]);
  });

  it("answers: valid reason only, numeric line id", async () => {
    assert.equal((await call("POST", "/oos-followup/cases/5/answer", "view_my_oos", { reason: "bogus" })).status, 400);
    assert.equal((await call("POST", "/oos-followup/cases/x/answer", "view_my_oos", { reason: "ordered" })).status, 422);
    assert.equal((await call("POST", "/oos-followup/cases/5/answer", "view_my_oos", { reason: "ordered", note: "PO raised" })).status, 200);
    assert.deepEqual([calls.at(-1)[1].id, calls.at(-1)[1].reason], [5, "ordered"]);
  });
});
