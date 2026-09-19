/**
 * THE TELEGRAM ATTENDANCE MINI APP API.
 *
 *   node --test routes/telegram_attendance.test.js
 *
 * REAL EXPRESS, REAL ROUTER, REAL HTTP. The usecases below it are doubles -
 * their rules are tested in their own files - but the requests here are
 * genuine, because the claims being made are about what a BROWSER can send:
 * an `employee_id` in the query string, an `employee_id` in the body, an
 * ordinary login token in the wrong header. Those cannot be asserted by
 * reading the source.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");

const buildRouter = require("../routes/telegram_attendance");
const { unProtectedRoutes } = require("../middlewares/auth");

const EMPLOYEE = 77;
const GOOD_TOKEN = "good-mini-app-token";

/** Records every employee id the usecase was asked about. */
const calls = { list: [], detail: [], submit: [], month: [], ot: [] };

const sessionUsecase = {
  exchange: async ({ initData }) => {
    if (initData !== "signed-and-fresh") {
      const err = new Error("Telegram authentication failed");
      err.name = "TelegramAuthError";
      err.code = "INIT_DATA_BAD_SIGNATURE";
      err.status = 401;
      throw err;
    }
    return { code: 200, token: GOOD_TOKEN, expires_in: 900, employee: { employee_id: EMPLOYEE } };
  },
  authenticate: async (token) => {
    if (token !== GOOD_TOKEN) {
      const err = new Error("Session expired. Please reopen from Telegram.");
      err.name = "TelegramAuthError";
      err.code = "MINI_APP_SESSION_INVALID";
      err.status = 401;
      throw err;
    }
    return { employee_id: EMPLOYEE, telegram_user_id: 501, session_id: "sid-1" };
  },
};

const miniAppUsecase = {
  listMissingDates: async (employeeId) => {
    calls.list.push(employeeId);
    return { code: 200, dates: [] };
  },
  getMonth: async (employeeId, month) => {
    calls.month.push([employeeId, month]);
    return { code: 200, month, days: [] };
  },
  getDateDetail: async (employeeId, date) => {
    calls.detail.push([employeeId, date]);
    return { code: 200, attendance_date: date };
  },
  submitRegularization: async (employeeId, body) => {
    calls.submit.push([employeeId, body]);
    return { code: 200, status: "PENDING" };
  },
  submitOtRequest: async (employeeId, body) => {
    calls.ot.push([employeeId, body]);
    // The minutes come BACK from the server; they never went in.
    return { code: 200, status: "PENDING", attendance_date: body.attendance_date, candidate_ot_minutes: 90 };
  },
};

let server;
let base;

before(async () => {
  const app = express();
  app.use(bodyParser.json());
  app.use("/", buildRouter(sessionUsecase, miniAppUsecase).getRouter());
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });
const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const authed = { "x-telegram-session": GOOD_TOKEN };

describe("the public-route registration", () => {
  /**
   * These five step past the global `x-access-token` gate. If one were ever
   * added to the router and NOT to the map, it would 403 for every Mini App
   * user; if one were removed from the router but left in the map, it would
   * be a path advertised as open. Both are caught here.
   */
  it("names exactly the five Mini App paths, and each with one method", () => {
    const paths = Object.keys(unProtectedRoutes).filter((p) => p.startsWith("/telegram/"));
    assert.deepEqual(paths.sort(), [
      "/telegram/attendance/date",
      "/telegram/attendance/missing-dates",
      "/telegram/attendance/month",
      "/telegram/attendance/ot-request",
      "/telegram/attendance/regularization",
      "/telegram/attendance/session",
    ]);
    assert.deepEqual(unProtectedRoutes["/telegram/attendance/ot-request"].methods, { post: true });
    assert.deepEqual(unProtectedRoutes["/telegram/attendance/month"].methods, { get: true });
    assert.deepEqual(unProtectedRoutes["/telegram/attendance/session"].methods, { post: true });
    assert.deepEqual(unProtectedRoutes["/telegram/attendance/missing-dates"].methods, { get: true });
    assert.deepEqual(unProtectedRoutes["/telegram/attendance/date"].methods, { get: true });
    assert.deepEqual(unProtectedRoutes["/telegram/attendance/regularization"].methods, { post: true });
  });
});

describe("the session exchange", () => {
  it("valid signed initData yields a scoped token", async () => {
    const res = await post("/telegram/attendance/session", { init_data: "signed-and-fresh" });
    const body = await res.json();
    assert.equal(body.code, 200);
    assert.equal(body.token, GOOD_TOKEN);
  });

  it("a forged payload is a 401, not a session", async () => {
    const res = await post("/telegram/attendance/session", { init_data: "forged" });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "INIT_DATA_BAD_SIGNATURE");
  });

  /**
   * THE BODY HAS ONE FIELD. An `employee_id` beside `init_data` is an
   * unknown key, and Joi refuses it - so it is a 422, never an override that
   * happens to be ignored today and read tomorrow.
   */
  it("an employee_id in the session body is REFUSED, not ignored", async () => {
    const res = await post("/telegram/attendance/session", {
      init_data: "signed-and-fresh",
      employee_id: 78,
    });
    assert.equal((await res.json()).code, 422);
  });
});

describe("the scoped token is the only way in", () => {
  it("no token at all is refused on every read and write", async () => {
    assert.equal((await get("/telegram/attendance/missing-dates")).status, 401);
    assert.equal((await get("/telegram/attendance/date?attendance_date=2026-09-17")).status, 401);
    assert.equal(
      (await post("/telegram/attendance/regularization", {
        attendance_date: "2026-09-17",
        punch_time: "2026-09-17 19:30:00",
        reason: "Forgot to punch out",
      })).status,
      401
    );
  });

  it("a token in the ordinary x-access-token header does not authenticate the Mini App", async () => {
    const res = await get("/telegram/attendance/missing-dates", { "x-access-token": GOOD_TOKEN });
    assert.equal(res.status, 401);
  });
});

describe("the browser cannot choose, supply or control the employee", () => {
  it("the missing-date list is always for the token's employee", async () => {
    calls.list.length = 0;
    const res = await get("/telegram/attendance/missing-dates", authed);
    assert.equal((await res.json()).code, 200);
    // The employee came from the TOKEN, not from the request...
    assert.deepEqual(calls.list, [EMPLOYEE]);
    // ...and is not handed back to the browser either.
    assert.equal((await (await get("/telegram/attendance/missing-dates", authed)).json()).employee_id, undefined);
  });

  it("an employee_id in the QUERY STRING is refused", async () => {
    calls.list.length = 0;
    const res = await get("/telegram/attendance/missing-dates?employee_id=78", authed);
    assert.equal((await res.json()).code, 422);
    assert.deepEqual(calls.list, [], "nothing was read for anybody");
  });

  it("an employee_id on the date detail is refused, and the date is still the token's employee's", async () => {
    calls.detail.length = 0;
    assert.equal(
      (await (await get("/telegram/attendance/date?attendance_date=2026-09-17&employee_id=78", authed)).json()).code,
      422
    );
    await get("/telegram/attendance/date?attendance_date=2026-09-17", authed);
    assert.deepEqual(calls.detail, [[EMPLOYEE, "2026-09-17"]]);
  });

  it("an employee_id in the SUBMIT BODY is refused", async () => {
    calls.submit.length = 0;
    const res = await post(
      "/telegram/attendance/regularization",
      {
        attendance_date: "2026-09-17",
        punch_time: "2026-09-17 19:30:00",
        reason: "Forgot to punch out",
        employee_id: 78,
      },
      authed
    );
    assert.equal((await res.json()).code, 422);
    assert.deepEqual(calls.submit, []);
  });

  it("a requested_for_employee_id in the SUBMIT BODY is refused", async () => {
    calls.submit.length = 0;
    const res = await post(
      "/telegram/attendance/regularization",
      {
        attendance_date: "2026-09-17",
        punch_time: "2026-09-17 19:30:00",
        reason: "Forgot to punch out",
        requested_for_employee_id: 78,
      },
      authed
    );
    assert.equal((await res.json()).code, 422);
    assert.deepEqual(calls.submit, []);
  });

  it("a punch_id in the SUBMIT BODY is refused - existing punches are read-only", async () => {
    const res = await post(
      "/telegram/attendance/regularization",
      {
        attendance_date: "2026-09-17",
        punch_time: "2026-09-17 19:30:00",
        reason: "Forgot to punch out",
        punch_id: 11,
      },
      authed
    );
    assert.equal((await res.json()).code, 422);
  });
});

describe("the submit contract", () => {
  it("accepts exactly a date, a punch time and a reason", async () => {
    calls.submit.length = 0;
    const res = await post(
      "/telegram/attendance/regularization",
      {
        attendance_date: "2026-09-17",
        punch_time: "2026-09-17 19:30:00",
        reason: "Forgot to punch out",
      },
      authed
    );
    assert.equal((await res.json()).code, 200);
    assert.deepEqual(calls.submit, [
      [
        EMPLOYEE,
        {
          attendance_date: "2026-09-17",
          punch_time: "2026-09-17 19:30:00",
          reason: "Forgot to punch out",
        },
      ],
    ]);
  });

  it("a missing reason is refused", async () => {
    const res = await post(
      "/telegram/attendance/regularization",
      { attendance_date: "2026-09-17", punch_time: "2026-09-17 19:30:00" },
      authed
    );
    assert.equal((await res.json()).code, 422);
  });

  it("a missing punch time is refused", async () => {
    const res = await post(
      "/telegram/attendance/regularization",
      { attendance_date: "2026-09-17", reason: "Forgot to punch out" },
      authed
    );
    assert.equal((await res.json()).code, 422);
  });
});

describe("what this namespace does NOT expose", () => {
  it("has no approval, no decision and no queue route", () => {
    const routes = buildRouter(sessionUsecase, miniAppUsecase)
      .getRouter()
      .stack.filter((l) => l.route)
      .map((l) => l.route.path);
    assert.deepEqual(routes.sort(), [
      "/telegram/attendance/date",
      "/telegram/attendance/missing-dates",
      "/telegram/attendance/month",
      "/telegram/attendance/ot-request",
      "/telegram/attendance/regularization",
      "/telegram/attendance/session",
    ]);
    // `ot-request` RAISES one; it decides nothing. The exclusions below are
    // about approval, and "approv" still matches nothing.
    assert.ok(!routes.some((p) => /approv|decision|pending|employee/i.test(p)));
  });
});

describe("My Attendance over HTTP", () => {
  it("needs the scoped token like every other read", async () => {
    assert.equal((await get("/telegram/attendance/month?month=2026-08")).status, 401);
  });

  it("is always for the token's employee, and returns no employee id", async () => {
    calls.month.length = 0;
    const res = await get("/telegram/attendance/month?month=2026-08", authed);
    const body = await res.json();
    assert.equal(body.code, 200);
    assert.equal(body.employee_id, undefined);
    assert.deepEqual(calls.month, [[EMPLOYEE, "2026-08"]]);
  });

  /**
   * THE WHOLE POINT, restated for this route: there is no parameter for an
   * employee, an outlet, a store, a designation or an approval role, and an
   * unknown key is a 422 rather than something quietly ignored.
   */
  it("refuses every parameter except the month", async () => {
    for (const extra of [
      "employee_id=78",
      "requested_for_employee_id=78",
      "store_id=3",
      "outlet_id=3",
      "designation_id=9",
      "approver_role=STORE_MANAGER",
    ]) {
      calls.month.length = 0;
      const res = await get(`/telegram/attendance/month?month=2026-08&${extra}`, authed);
      assert.equal((await res.json()).code, 422, `${extra} must be refused`);
      assert.deepEqual(calls.month, [], `${extra} read nothing for anybody`);
    }
  });

  it("validates the month at the edge of the router", async () => {
    for (const month of ["2026-13", "2026-00", "2026-9", "26-08", "2026-08-01", "august"]) {
      const res = await get(`/telegram/attendance/month?month=${month}`, authed);
      assert.equal((await res.json()).code, 422, `${month} must be refused`);
    }
    assert.equal((await (await get("/telegram/attendance/month", authed)).json()).code, 422);
  });
});

/* ============================================ the OT request endpoint */

/**
 * THE OT REQUEST FROM TELEGRAM.
 *
 * The same claims the regularisation endpoint makes, for the second request
 * type, plus the one that is specific to OT: THE BROWSER HAS NO FIELD FOR A
 * DURATION. These are asserted over real HTTP because they are claims about
 * what a browser can put on the wire.
 */
describe("POST /telegram/attendance/ot-request", () => {
  const otBody = { attendance_date: "2026-09-17", reason: "Stock count ran late" };

  it("needs the scoped token; no token and a login token are both 401", async () => {
    assert.equal((await post("/telegram/attendance/ot-request", otBody)).status, 401);
    assert.equal(
      (await post("/telegram/attendance/ot-request", otBody, { "x-access-token": GOOD_TOKEN })).status,
      401
    );
  });

  it("accepts exactly a date and a reason, for the TOKEN's employee", async () => {
    calls.ot.length = 0;
    const res = await post("/telegram/attendance/ot-request", otBody, authed);
    const body = await res.json();
    assert.equal(body.code, 200);
    assert.deepEqual(calls.ot, [[EMPLOYEE, { attendance_date: "2026-09-17", reason: "Stock count ran late" }]]);
    // The figure is the SERVER's, handed back rather than taken in.
    assert.equal(body.candidate_ot_minutes, 90);
  });

  it("cannot be pointed at another employee, however the payload is dressed up", async () => {
    for (const extra of [{ employee_id: 78 }, { requested_for_employee_id: 78 }]) {
      calls.ot.length = 0;
      // eslint-disable-next-line no-await-in-loop
      const res = await post("/telegram/attendance/ot-request", { ...otBody, ...extra }, authed);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await res.json()).code, 422, JSON.stringify(extra));
      assert.deepEqual(calls.ot, [], "nothing was raised for anybody");
    }
  });

  it("HAS NO FIELD FOR A DURATION: OT minutes from Telegram are refused outright", async () => {
    for (const extra of [
      { candidate_ot_minutes: 600 },
      { approved_ot_minutes: 600 },
      { ot_minutes: 600 },
      { minutes: 600 },
    ]) {
      calls.ot.length = 0;
      // eslint-disable-next-line no-await-in-loop
      const res = await post("/telegram/attendance/ot-request", { ...otBody, ...extra }, authed);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await res.json()).code, 422, JSON.stringify(extra));
      assert.deepEqual(calls.ot, []);
    }
  });

  it("a missing or too-short reason is refused, as it is on the correction", async () => {
    for (const reason of [undefined, "", "abc"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post("/telegram/attendance/ot-request", { ...otBody, reason }, authed);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await res.json()).code, 422, `reason=${JSON.stringify(reason)}`);
    }
  });

  it("a punch_time is refused - an OT request is not a correction", async () => {
    const res = await post(
      "/telegram/attendance/ot-request",
      { ...otBody, punch_time: "2026-09-17 23:30:00" },
      authed
    );
    assert.equal((await res.json()).code, 422);
  });
});
