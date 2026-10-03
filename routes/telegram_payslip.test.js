/**
 * MY PAYSLIPS - THE MINI APP API, END TO END OVER HTTP.
 *
 *   node --test routes/telegram_payslip.test.js
 *
 * REAL EXPRESS, REAL ROUTER, REAL SESSION. Identity is proved exactly as in
 * production: Telegram-signed initData (HMAC over a test bot token) ->
 * active employee_telegram_identity -> an RS256 Mini App session token. The
 * payslip usecase is the real one; only the repository is in memory, and it
 * applies the same WHERE clause the SQL does (employee, ref, ACTIVE,
 * published). The SQL itself is proven in repository/payrun_payslip.mysql.test.js.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const bodyParser = require("body-parser");

const { createJwtService } = require("../services/jwt");
const { signInitData } = require("../utils/telegram_init_data");
const { resolveIdentity } = require("../middlewares/auth");
const buildSession = require("../usecase/telegram_attendance_session");
const buildPayslips = require("../usecase/telegram_payslip");
const buildRouter = require("./telegram_payslip");
const { buildPayslipSnapshot, freezeSnapshot } = require("../utils/payslip_snapshot");

const BOT_TOKEN = "123456:AAH-test-bot-token";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const jwtService = createJwtService({ privateKey, publicKeys: { test: publicKey }, activeKid: "test", legacyKid: "test" });

// Employee A (101) on Telegram user 5001; employee B (202) on 5002; 303 unlinked.
const IDENTITIES = [
  { employee_id: 101, telegram_user_id: 5001, disconnected_at: null },
  { employee_id: 202, telegram_user_id: 5002, disconnected_at: null },
  { employee_id: 303, telegram_user_id: 5003, disconnected_at: "2026-09-01 00:00:00" },
];

const ref = () => crypto.randomBytes(16).toString("hex");
const snapFor = (employeeId, month, net) => {
  const net2 = `${net}.00`;
  return freezeSnapshot(buildPayslipSnapshot({
    period: { year: 2026, month },
    calculation: {
      payrun_calculation_id: employeeId * 10 + month, payrun_employee_id: employeeId * 100 + month, employee_id: employeeId,
      salary_earnings: net2, total_earnings: net2, total_employee_deductions: "0.00", net_pay: net2, net_pay_rounding: "0.00",
      pay_type: "CASH", calculation_version: 2, calculation_revision: 1, calculation_hash: "c".repeat(32),
    },
    employee: { employee_id: employeeId, employee_name: `Emp ${employeeId}`, basic: "1", hra: "0", conveyance: "0", special_allowance: "0" },
    company: { name: "Daily Needs Departmental Store", source: "company_details:1" },
  }));
};

/** payrun_payslip + the calculation's published flag, in memory. */
const slips = [];
const addSlip = (employeeId, month, net, { status = "ACTIVE", published = true } = {}) => {
  const frozen = snapFor(employeeId, month, net);
  const row = {
    payslip_id: slips.length + 1, payslip_ref: ref(), employee_id: employeeId, period_year: 2026, period_month: month,
    payslip_version: 1, template_version: "payslip-v1", snapshot_json: frozen.text, snapshot_sha256: frozen.sha256,
    status, published, published_at: "2026-10-02 10:00:00", first_viewed_at: null, last_viewed_at: null, view_count: 0,
  };
  slips.push(row);
  return row;
};
const visible = (r) => r.status === "ACTIVE" && r.published;
const repoCalls = [];
const payslipRepo = {
  listPublishedForEmployee: async (employeeId) => {
    repoCalls.push(["list", employeeId]);
    return slips
      .filter((r) => r.employee_id === employeeId && visible(r))
      .sort((a, b) => b.period_year - a.period_year || b.period_month - a.period_month);
  },
  getPublishedForEmployee: async (employeeId, payslipRef) => {
    repoCalls.push(["get", employeeId, payslipRef]);
    return slips.find((r) => r.employee_id === employeeId && r.payslip_ref === payslipRef && visible(r)) || null;
  },
  recordView: async (payslipId, employeeId) => {
    const r = slips.find((x) => x.payslip_id === payslipId && x.employee_id === employeeId && x.status === "ACTIVE");
    if (!r) return false;
    const stamp = `2026-10-04 09:42:${String(r.view_count).padStart(2, "0")}`;
    r.first_viewed_at = r.first_viewed_at || stamp;
    r.last_viewed_at = stamp;
    r.view_count += 1;
    return true;
  },
};
const rendered = [];
const renderPdf = async (snapshot) => {
  rendered.push(snapshot);
  return Buffer.from(`%PDF-1.4 ${snapshot.employee.employee_id} ${snapshot.final.net_pay}`);
};

const session = buildSession({
  identityRepo: {
    getActiveIdentityByTelegramUser: async (id) =>
      IDENTITIES.find((r) => r.telegram_user_id === Number(id) && r.disconnected_at === null) || null,
  },
  jwtService,
  getBotToken: () => BOT_TOKEN,
});
let clockMs = Date.now();
const payslips = buildPayslips({ payslipRepo, renderPdf, now: () => clockMs });

let server;
let base;
const A_SEP = addSlip(101, 9, 24834);
const A_AUG = addSlip(101, 8, 23000);
const A_JUL = addSlip(101, 7, 22000);
const A_OLD_ARCHIVED = addSlip(101, 6, 99999, { status: "ARCHIVED" });
const A_UNPUBLISHED = addSlip(101, 5, 88888, { published: false });
const B_SEP = addSlip(202, 9, 31000);

before(async () => {
  const app = express();
  app.use(bodyParser.json());
  app.use("/", buildRouter(session, payslips).getRouter());
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });
const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const tokenFor = async (telegramUserId) => {
  const initData = signInitData(
    { user: JSON.stringify({ id: telegramUserId, first_name: "T" }), auth_date: String(Math.floor(Date.now() / 1000)) },
    BOT_TOKEN
  );
  const out = await session.exchange({ initData });
  return { "x-telegram-session": out.token };
};

describe("the employee sees only their own published payslips", () => {
  it("list: own ACTIVE published payslips, newest month first; no figures in the list", async () => {
    const res = await get("/telegram/payslips", await tokenFor(5001));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.payslips.map((p) => p.label), ["September 2026", "August 2026", "July 2026"]);
    assert.ok(body.payslips.every((p) => p.status === "Published"));
    assert.ok(!JSON.stringify(body).includes("24834"));
    assert.ok(!JSON.stringify(body).includes("employee_id"));
  });

  it("detail: own payslip loads from the snapshot, with the rounded Net Pay, and records the first view", async () => {
    const headers = await tokenFor(5001);
    const res = await get(`/telegram/payslips/detail?ref=${A_SEP.payslip_ref}`, headers);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store, private, max-age=0");
    const body = await res.json();
    assert.equal(body.payslip.snapshot.final.net_pay, "24834.00");
    assert.equal(body.payslip.filename, "Payslip_Sep-2026_101_Emp-101.pdf");
    assert.equal(body.payslip.snapshot.source, undefined, "internal references are not sent");
    assert.equal(A_SEP.first_viewed_at, "2026-10-04 09:42:00");
  });

  it("VIEW TRACKING: a repeat open keeps first_viewed_at and moves last_viewed_at", async () => {
    const headers = await tokenFor(5001);
    await get(`/telegram/payslips/detail?ref=${A_SEP.payslip_ref}`, headers);
    await get(`/telegram/payslips/detail?ref=${A_SEP.payslip_ref}`, headers);
    assert.equal(A_SEP.first_viewed_at, "2026-10-04 09:42:00");
    assert.equal(A_SEP.last_viewed_at, "2026-10-04 09:42:02");
    assert.equal(A_SEP.view_count, 3);
  });

  it("archived and unpublished payslips are 404, exactly like a missing one", async () => {
    const headers = await tokenFor(5001);
    for (const r of [A_OLD_ARCHIVED, A_UNPUBLISHED]) {
      const res = await get(`/telegram/payslips/detail?ref=${r.payslip_ref}`, headers);
      assert.equal(res.status, 404);
      const pdf = await get(`/telegram/payslips/pdf?ref=${r.payslip_ref}`, headers);
      assert.equal(pdf.status, 404);
    }
    const missing = await get(`/telegram/payslips/detail?ref=${ref()}`, headers);
    assert.equal(missing.status, 404);
  });
});

describe("EMPLOYEE A CANNOT REACH EMPLOYEE B", () => {
  it("A asking for B's payslip ref gets 404 for the detail, the PDF and a PDF link - and B's view is not recorded", async () => {
    const asA = await tokenFor(5001);
    const before = B_SEP.view_count;
    assert.equal((await get(`/telegram/payslips/detail?ref=${B_SEP.payslip_ref}`, asA)).status, 404);
    assert.equal((await get(`/telegram/payslips/pdf?ref=${B_SEP.payslip_ref}`, asA)).status, 404);
    assert.equal((await post("/telegram/payslips/pdf-link", { ref: B_SEP.payslip_ref }, asA)).status, 404);
    assert.equal(B_SEP.view_count, before);
    assert.ok(!rendered.some((s) => s.employee.employee_id === 202));
  });

  it("an employee_id anywhere is refused (400) - query, body - never an override", async () => {
    const asA = await tokenFor(5001);
    assert.equal((await get("/telegram/payslips?employee_id=202", asA)).status, 400);
    assert.equal((await get(`/telegram/payslips/detail?ref=${B_SEP.payslip_ref}&employee_id=202`, asA)).status, 400);
    assert.equal((await post("/telegram/payslips/pdf-link", { ref: B_SEP.payslip_ref, employee_id: 202 }, asA)).status, 400);
    assert.equal((await get(`/telegram/payslips/pdf?ref=${B_SEP.payslip_ref}&employee_id=202`, asA)).status, 400);
  });

  it("every repository read was pinned to the session's employee, never another", async () => {
    repoCalls.length = 0;
    const asB = await tokenFor(5002);
    await get("/telegram/payslips", asB);
    await get(`/telegram/payslips/detail?ref=${A_SEP.payslip_ref}`, asB);
    assert.ok(repoCalls.length >= 2);
    assert.ok(repoCalls.every((c) => c[1] === 202), JSON.stringify(repoCalls));
  });

  it("B lists only B's own", async () => {
    const body = await (await get("/telegram/payslips", await tokenFor(5002))).json();
    assert.deepEqual(body.payslips.map((p) => p.payslip_ref), [B_SEP.payslip_ref]);
  });
});

describe("the session gate", () => {
  it("no header, a garbage header, an ordinary login token: all 401", async () => {
    assert.equal((await get("/telegram/payslips")).status, 401);
    assert.equal((await get("/telegram/payslips", { "x-telegram-session": "garbage" })).status, 401);
    const login = await jwtService.sign({ auth_ver: 2, sub: "12", id: 12, employee_id: 101 }, "1d");
    assert.equal((await get("/telegram/payslips", { "x-telegram-session": login })).status, 401);
    assert.equal((await get(`/telegram/payslips/pdf?ref=${A_SEP.payslip_ref}`, { "x-telegram-session": login })).status, 401);
  });

  it("an expired session is 401", async () => {
    const expired = await jwtService.sign({ scope: "telegram_attendance_miniapp", emp: 101, tgu: 5001, sid: "x" }, -10);
    assert.equal((await get("/telegram/payslips", { "x-telegram-session": expired })).status, 401);
  });

  it("a retired (disconnected) Telegram identity cannot open a session at all", async () => {
    await assert.rejects(tokenFor(5003), (e) => e.status === 401);
  });

  it("stale initData (older than 5 minutes) is refused", async () => {
    const initData = signInitData(
      { user: JSON.stringify({ id: 5001 }), auth_date: String(Math.floor(Date.now() / 1000) - 3600) },
      BOT_TOKEN
    );
    await assert.rejects(session.exchange({ initData }), (e) => e.status === 401);
  });
});

describe("the PDF, on demand", () => {
  it("with the session header: rendered from the snapshot, streamed, no-store, safe filename", async () => {
    rendered.length = 0;
    const res = await get(`/telegram/payslips/pdf?ref=${A_SEP.payslip_ref}`, await tokenFor(5001));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="Payslip_Sep-2026_101_Emp-101.pdf"');
    assert.equal(res.headers.get("cache-control"), "no-store, private, max-age=0");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "%PDF-1.4 101 24834.00");
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].final.net_pay, "24834.00", "the PDF and the detail read the same snapshot");
  });

  it("the iOS fallback link: owner-only, one payslip, opaque (not a JWT), not a session, and SINGLE-USE", async () => {
    const asA = await tokenFor(5001);
    const link = await (await post("/telegram/payslips/pdf-link", { ref: A_AUG.payslip_ref }, asA)).json();
    assert.equal(link.code, 200);
    assert.equal(link.expires_in, 60);
    assert.match(link.path, /^\/telegram\/payslips\/pdf\?t=[A-Za-z0-9_-]{43}$/);
    const token = link.path.split("t=")[1];
    assert.equal(token.split(".").length, 1, "not a JWT");
    await assert.rejects(jwtService.verify(token), "not verifiable as a signed token");
    // not a Mini App session
    assert.equal((await get("/telegram/payslips", { "x-telegram-session": token })).status, 401);
    // first use works ...
    const res = await get(link.path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.ok(Buffer.from(await res.arrayBuffer()).toString().includes("23000.00"));
    // ... and only once
    assert.equal((await get(link.path)).status, 401);
  });

  it("the link expires after 60 seconds", async () => {
    const asA = await tokenFor(5001);
    const link = await (await post("/telegram/payslips/pdf-link", { ref: A_AUG.payslip_ref }, asA)).json();
    clockMs += 61 * 1000;
    try {
      assert.equal((await get(link.path)).status, 401);
    } finally {
      clockMs = Date.now();
    }
  });

  it("a tampered link, a session token as a link, and an unknown token are refused", async () => {
    const asA = await tokenFor(5001);
    const link = await (await post("/telegram/payslips/pdf-link", { ref: A_AUG.payslip_ref }, asA)).json();
    const token = link.path.split("t=")[1];
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    assert.equal((await get(`/telegram/payslips/pdf?t=${tampered}`)).status, 401);
    assert.equal((await get(`/telegram/payslips/pdf?t=${encodeURIComponent(asA["x-telegram-session"].slice(0, 60))}`)).status, 401);
    assert.equal((await get("/telegram/payslips/pdf?t=forged")).status, 401);
    assert.equal((await get("/telegram/payslips/pdf?token=anything")).status, 400, "the old parameter is gone");
    // the untampered one still works once - a bad guess does not burn it
    assert.equal((await get(link.path)).status, 200);
  });

  it("a link for a payslip archived before it is spent stops working", async () => {
    const asA = await tokenFor(5001);
    const link = await (await post("/telegram/payslips/pdf-link", { ref: A_JUL.payslip_ref }, asA)).json();
    A_JUL.status = "ARCHIVED";
    try {
      assert.equal((await get(link.path)).status, 404);
    } finally {
      A_JUL.status = "ACTIVE";
    }
  });

  it("ref and token together, or neither, is refused", async () => {
    assert.equal((await get("/telegram/payslips/pdf")).status, 400);
    assert.equal((await get(`/telegram/payslips/pdf?ref=${A_SEP.payslip_ref}&t=x`)).status, 400);
  });
});
