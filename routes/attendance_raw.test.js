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

  it("defines the list, summary, audit and the two CSV exports, and nothing else", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      ["GET /raw", "GET /raw/export.csv", "GET /raw/punches", "GET /raw/punches/export.csv", "GET /raw/summary"]
    );
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
