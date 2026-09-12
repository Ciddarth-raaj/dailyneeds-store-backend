/**
 * Attendance routes: the surface and the key on each endpoint.
 *
 *   node --test routes/attendance_raw.test.js
 *
 * Built with a fake `permissions` that records what each route asked for,
 * as routes/work_shift.test.js does. The Punch Audit has its own key (D7);
 * the export has its own key (D5); the Attendance List never accepts a
 * device filter (R14) - the last is exercised through the usecase here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_raw");
const buildDeviceRoutes = require("./biomax_device");
const P = require("../constants/hr_permissions");

function guardsOf(router) {
  const guards = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean);
    guards.push({ method, path: layer.route.path, guard });
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
  actorFor: async () => ({ userId: 1, employeeId: 1 }),
};

describe("/attendance", () => {
  const guards = guardsOf(buildRoutes({}, permissions).getRouter());
  const find = (m, p) => guards.find((g) => g.method === m && g.path === p);

  it("defines the list, summary, audit, the two CSV exports and Void Punch, and nothing else", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      ["GET /raw", "GET /raw/export.csv", "GET /raw/punches", "GET /raw/punches/export.csv", "GET /raw/summary", "POST /raw/punches/:id/void"]
    );
  });

  it("Void Punch is the one write, behind its own key void_attendance_punch - not the audit key", () => {
    assert.deepEqual(find("POST", "/raw/punches/:id/void").guard.keys, [P.VOID_ATTENDANCE_PUNCH]);
    assert.notEqual(P.VOID_ATTENDANCE_PUNCH, P.VIEW_ATTENDANCE_PUNCH_AUDIT);
    assert.equal(P.VOID_ATTENDANCE_PUNCH, "void_attendance_punch");
    assert.equal(guards.filter((g) => g.method !== "GET").length, 1);
  });

  it("every endpoint is guarded", () => {
    for (const g of guards) assert.ok(g.guard, `${g.method} ${g.path} has a guard`);
  });

  it("the Attendance List and its summary require view_raw_attendance", () => {
    assert.deepEqual(find("GET", "/raw").guard.keys, [P.VIEW_RAW_ATTENDANCE]);
    assert.deepEqual(find("GET", "/raw/summary").guard.keys, [P.VIEW_RAW_ATTENDANCE]);
  });

  it("the Attendance List CSV requires export_raw_attendance (D5)", () => {
    assert.deepEqual(find("GET", "/raw/export.csv").guard.keys, [P.EXPORT_RAW_ATTENDANCE]);
  });

  it("the Punch Audit and its CSV require view_attendance_punch_audit, a separate key (D7)", () => {
    assert.deepEqual(find("GET", "/raw/punches").guard.keys, [P.VIEW_ATTENDANCE_PUNCH_AUDIT]);
    assert.deepEqual(find("GET", "/raw/punches/export.csv").guard.keys, [P.VIEW_ATTENDANCE_PUNCH_AUDIT]);
    assert.notEqual(P.VIEW_ATTENDANCE_PUNCH_AUDIT, P.VIEW_RAW_ATTENDANCE);
  });

  it("no endpoint is opened by a legacy or unrelated key", () => {
    for (const g of guards) {
      for (const k of g.guard.keys) {
        assert.ok(!["view_shift", "view_employees", "view_work_shifts", "view_reports"].includes(k), `${g.path} uses ${k}`);
      }
    }
  });
});

describe("/attendance/devices", () => {
  const guards = guardsOf(buildDeviceRoutes({}, permissions).getRouter());
  const reads = guards.filter((g) => g.method === "GET");
  const writes = guards.filter((g) => g.method === "POST");

  it("defines three reads and five writes", () => {
    assert.deepEqual(reads.map((g) => g.path).sort(), ["/", "/details", "/unregistered"]);
    assert.deepEqual(writes.map((g) => g.path).sort(), ["/assign", "/correct-cloud-id", "/create", "/deactivate", "/update-details"]);
  });

  it("reads require view_biomax_devices; writes require manage_biomax_devices", () => {
    for (const g of reads) assert.deepEqual(g.guard.keys, [P.VIEW_BIOMAX_DEVICES], g.path);
    for (const g of writes) assert.deepEqual(g.guard.keys, [P.MANAGE_BIOMAX_DEVICES], g.path);
  });

  it("there is no delete: a device is deactivated, never removed", () => {
    assert.ok(!guards.some((g) => /delete|remove/i.test(g.path)));
    assert.ok(!guards.some((g) => g.method === "DELETE"));
  });
});

describe("Attendance List refuses device filters end to end (R14)", () => {
  it("answers 400 naming the Punch Audit when dev_id is sent", async () => {
    const usecase = require("../usecase/attendance_raw")({
      async listDated() { return []; },
      async listPunches() { return []; },
      async summary() { return { groups: [], unregistered: [] }; },
    });
    const routes = buildRoutes(usecase, permissions);
    const handler = routes.getRouter().stack.find((l) => l.route && l.route.path === "/raw").route.stack.slice(-1)[0].handle;
    let status = null;
    let body = null;
    const res = {
      status(s) { status = s; return this; },
      json(b) { body = b; return this; },
      end() {},
      headersSent: false,
    };
    await handler({ query: { from: "2026-09-15", to: "2026-09-15", dev_id: "X" } }, res);
    assert.equal(status, 400);
    assert.match(body.msg, /Punch Audit/);
  });
});


/* ------------------------------------------- Void Punch, through the REAL guard */

const buildPermissions = require("../middlewares/permissions");

/** Run guards then handler for a route, as Express would. */
async function invoke(routes, method, path, req) {
  const layer = routes.getRouter().stack.find((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  assert.ok(layer, `${method} ${path} exists`);
  const res = {
    statusCode: 200, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  for (const handle of layer.route.stack.map((s) => s.handle)) {
    // eslint-disable-next-line no-await-in-loop
    const proceeded = await new Promise((resolve) => {
      const maybe = handle(req, res, () => resolve(true));
      Promise.resolve(maybe).then(() => resolve(false));
    });
    if (!proceeded) break;
  }
  return res;
}

const STAFF = 5;   // holds nothing
const AUDITOR = 6; // may view the Punch Audit, may not void
const VOIDER = 7;  // holds void_attendance_punch

const realPermissions = buildPermissions({
  getPermissionById: async (designationId) =>
    ({
      [AUDITOR]: [P.VIEW_ATTENDANCE_PUNCH_AUDIT],
      [VOIDER]: [P.VOID_ATTENDANCE_PUNCH],
    }[designationId] || []).map((permission_key) => ({ permission_key })),
});

const reqAs = (designationId, body = { reason: "Duplicate device punch" }, userType = 1) => ({
  decoded: { id: 1, user_id: 70, employee_id: 7, designation_id: designationId, user_type: userType },
  params: { id: "1001" },
  body,
  query: {},
});

function fakeVoidUsecase() {
  const calls = [];
  return {
    calls,
    voidPunch: async (args) => {
      calls.push(args);
      return { code: 200, attendance_punch_void_id: 1, biomax_punch_id: Number(args.biomax_punch_id), recalculated: true, msg: "ok" };
    },
  };
}

describe("POST /raw/punches/:id/void - the real permission middleware", () => {
  it("20. permission required: an employee holding nothing is refused and nothing is voided", async () => {
    const usecase = fakeVoidUsecase();
    const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(STAFF));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.length, 0);
  });

  it("21. an unauthorized actor is rejected even though they may VIEW the Punch Audit", async () => {
    const usecase = fakeVoidUsecase();
    const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(AUDITOR));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.length, 0);
  });

  it("a holder of void_attendance_punch reaches the usecase, with the actor from the session and the id from the path", async () => {
    const usecase = fakeVoidUsecase();
    const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(VOIDER));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, 200);
    assert.deepEqual(usecase.calls, [{ biomax_punch_id: "1001", reason: "Duplicate device punch", source: null, actor: { employee_id: 7, user_id: 70 } }]);
  });

  it("an administrator (user_type 2) passes through the existing bypass - no new authorization model", async () => {
    const usecase = fakeVoidUsecase();
    const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(STAFF, undefined, 2));
    assert.equal(res.statusCode, 200);
    assert.equal(usecase.calls.length, 1);
  });

  it("the body accepts reason and an optional source only: employee_id, voided_by and a punch time are 400s, never overrides", async () => {
    const usecase = fakeVoidUsecase();
    for (const body of [
      { reason: "Duplicate device punch", employee_id: 1 },
      { reason: "Duplicate device punch", voided_by: 9 },
      { reason: "Duplicate device punch", io_time: "2020-01-01 00:00:00" },
      { reason: "    " },
      {},
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(VOIDER, body));
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal(usecase.calls.length, 0);
  });

  it("the pending-request block arrives as a clear 400 carrying the request", async () => {
    const err = new Error("This attendance date has a pending Attendance/OT request. Decide or cancel it before voiding a raw punch.");
    err.name = "ValidationError";
    err.pending_request = { attendance_approval_request_id: 55, request_type: "OT", attendance_date: "2026-09-14" };
    const usecase = { voidPunch: async () => { throw err; } };
    const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(VOIDER));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.msg, err.message);
    assert.deepEqual(res.body.pending_request, err.pending_request);
  });

  it("a nonexistent punch is a 404 with the message", async () => {
    const err = new Error("No raw punch exists for id 1001");
    err.name = "NotFoundError";
    const usecase = { voidPunch: async () => { throw err; } };
    const res = await invoke(buildRoutes({}, realPermissions, usecase), "POST", "/raw/punches/:id/void", reqAs(VOIDER));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.msg, "No raw punch exists for id 1001");
  });
});
