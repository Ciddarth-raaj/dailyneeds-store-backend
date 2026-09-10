/**
 * Stage 0C / C1c — what a lifecycle transition does to an existing session.
 *
 *   node --test middlewares/lifecycle_auth.test.js
 *
 * Two things must hold, and they pull in opposite directions:
 *
 *   leaving  - an employee whose status drops to 0 loses access at once,
 *              which Stage 0A's Gate 14 already does;
 *   rejoining - and when status returns to 1, the token they held BEFORE
 *              they left must not start working again. Gate 14's own comment
 *              says "reactivating the employee reinstates access with no
 *              change to the user row", which is exactly the hole. C1c closes
 *              it by bumping `token_valid_from` when it opens a rejoin
 *              period - the existing Stage 0A revocation mechanism, not a
 *              second one.
 *
 * The last test in this file is deliberately a proof of the gap: with
 * AUTH_TOKEN_VALID_FROM_ENABLED off, the bump is recorded and ignored. That
 * flag must be on in production for requirement 22 to hold, and this test
 * fails loudly if anyone assumes otherwise.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-c1c-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const auth = require("./auth");
const baseConfig = require("../config/auth");
const jwtService = require("../services/jwt");
const lifecycle = require("../usecase/employee_lifecycle");

const USER_ID = 41;
const EMPLOYEE_ID = 101;

/**
 * The `user` row and its joined employee status, as getSessionState returns
 * them. `token_valid_from` starts NULL, exactly as an account that has never
 * been revoked.
 */
const session = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

/** The real repository method C1c calls, over this one row. */
const userRepo = {
  async bumpTokenValidFromByEmployeeId(employeeId) {
    if (Number(employeeId) === EMPLOYEE_ID) session.token_valid_from = new Date();
  },
};

/** No caching, so a state change is visible to the very next request. */
const config = {
  ...baseConfig,
  login: { ...baseConfig.login, tokenValidFromEnabled: true, tokenValidFromCacheMs: 0 },
};

let server, port;

before(async () => {
  const app = express();
  app.use(bodyParser.json());
  app.use(
    auth.create({
      config,
      userUsecase: { getSessionState: async () => ({ ...session }) },
    })
  );
  app.get("/employee/directory", (req, res) => res.json([{ employee_id: 1, employee_name: "ok" }]));
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

/** A token issued now. `iat` is whole seconds, so tokens made in the same second tie. */
const issueToken = () =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: 1,
      designation_id: 4,
      store_id: 2,
    },
    "1d"
  );

const call = async (token) => {
  const res = await fetch(`http://127.0.0.1:${port}/employee/directory`, {
    headers: { "x-access-token": await token },
  });
  const body = await res.json();
  return { status: res.status, body };
};

/**
 * `token_valid_from` is compared against the token's `iat`, which has
 * one-second resolution. Waiting a second before issuing the "fresh" token is
 * what a real login would do; without it the comparison is a coin toss.
 */
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

describe("an employee who leaves", () => {
  it("21. is refused on their existing token as soon as status drops to 0", async () => {
    session.employee_status = 1;
    session.token_valid_from = null;
    const token = issueToken();
    assert.equal((await call(token)).status, 200, "employed: the token works");

    session.employee_status = 0; // the sync marked them terminated
    const r = await call(token);
    assert.equal(r.body.code, 403);
    assert.equal(r.body.error, "EMPLOYEE_INACTIVE");
  });
});

describe("22. an employee who rejoins", () => {
  it("does NOT get their pre-resignation token back when status returns to 1", async () => {
    session.employee_status = 1;
    session.token_valid_from = null;
    const oldToken = issueToken();
    assert.equal((await call(oldToken)).status, 200);

    // resign
    session.employee_status = 0;
    assert.equal((await call(oldToken)).body.error, "EMPLOYEE_INACTIVE");

    await nextSecond();

    // rejoin, exactly as the reconciler does it
    session.employee_status = 1;
    await userRepo.bumpTokenValidFromByEmployeeId(EMPLOYEE_ID);

    const r = await call(oldToken);
    assert.equal(r.body.code, 403, "the old token must not be resurrected");
    assert.equal(r.body.error, "TOKEN_REVOKED");
  });

  it("23. and a fresh login after the rejoin works normally", async () => {
    await nextSecond();
    const freshToken = issueToken();
    const r = await call(freshToken);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ employee_id: 1, employee_name: "ok" }]);
  });
});

describe("the reconciler is what triggers the revocation", () => {
  /** Enough of the repository to drive one rejoin. */
  const makeRepo = (employee, periods) => ({
    withTransaction: async (fn) => fn({}),
    assertDateLocale: async () => {},
    lockAndReadEmployee: async () => ({ ...employee }),
    getLatestPeriod: async () =>
      periods.length ? { ...periods[periods.length - 1] } : null,
    insertPeriod: async (_tx, p) => {
      periods.push({ period_id: periods.length + 1, ...p });
      return periods.length;
    },
    closePeriod: async (_tx, id, patch) => {
      const row = periods.find((p) => p.period_id === id);
      if (!row || row.period_state !== "open") return 0;
      Object.assign(row, { period_state: "closed", ...patch });
      return 1;
    },
    fillNullDate: async () => 0,
    insertEvent: async () => 1,
    listEmployeesNeedingReconciliation: async () => [EMPLOYEE_ID],
  });

  it("a rejoin bumps token_valid_from; a quiet sync does not", async () => {
    const periods = [
      {
        period_id: 1, employee_id: EMPLOYEE_ID, period_no: 1, period_state: "closed",
        joined_on: "2020-01-01", ended_on: "2023-01-01", end_reason_type: "resignation",
        source: "backfill", needs_review: 0,
      },
    ];
    const employee = {
      employee_id: EMPLOYEE_ID, status: 1, resignation_date: null,
      raw_date_of_joining: "2024-06-01", parsed_joined_on: "2024-06-01",
    };
    const bumps = [];
    const uc = lifecycle(makeRepo(employee, periods), {
      bumpTokenValidFromByEmployeeId: async (id) => bumps.push(id),
    });

    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_rejoin");
    assert.deepEqual(bumps, [EMPLOYEE_ID], "the rejoin revoked the old sessions");

    // Steady state: nothing changed, so nobody is logged out.
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
    assert.equal(bumps.length, 1, "a quiet nightly sync must not log people out");
  });

  it("a failed revocation is logged, not allowed to undo a correct period", async () => {
    const periods = [];
    const employee = {
      employee_id: EMPLOYEE_ID, status: 1, resignation_date: null,
      raw_date_of_joining: null, parsed_joined_on: null,
    };
    const uc = lifecycle(makeRepo(employee, periods), {
      bumpTokenValidFromByEmployeeId: async () => {
        throw new Error("user table unavailable");
      },
    });
    // An initial join does not revoke anything, so force the revoking path.
    periods.push({
      period_id: 1, employee_id: EMPLOYEE_ID, period_no: 1, period_state: "closed",
      joined_on: null, ended_on: null, end_reason_type: "unknown", source: "backfill", needs_review: 1,
    });
    const res = await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(res.action, "open_rejoin");
    assert.equal(periods.length, 2, "the period survived the revocation failure");
  });
});

describe("the production prerequisite", () => {
  /**
   * PROOF OF THE GAP, not a wish. With AUTH_TOKEN_VALID_FROM_ENABLED off -
   * which is the code default - the bump is written and then never read, and
   * the old token works again the moment status returns to 1.
   */
  it("with tokenValidFrom disabled, the bump has no effect - the flag must be ON in production", async () => {
    const laxConfig = {
      ...baseConfig,
      login: { ...baseConfig.login, tokenValidFromEnabled: false, tokenValidFromCacheMs: 0 },
    };
    const local = { ...session, employee_status: 1, token_valid_from: null };
    const app = express();
    app.use(bodyParser.json());
    app.use(
      auth.create({ config: laxConfig, userUsecase: { getSessionState: async () => ({ ...local }) } })
    );
    app.get("/employee/directory", (_req, res) => res.json([]));
    const s = await new Promise((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    const p = s.address().port;
    // An authentication refusal is HTTP 200 carrying { code: 403 } - the
    // Stage 0A `deny()` shape - so the body is what says yes or no.
    const hit = async (token) => {
      const res = await fetch(`http://127.0.0.1:${p}/employee/directory`, {
        headers: { "x-access-token": await token },
      });
      const body = await res.json();
      return Array.isArray(body) ? 200 : Number(body.code);
    };

    try {
      const oldToken = issueToken();
      assert.equal(await hit(oldToken), 200);
      local.employee_status = 0;
      assert.equal(await hit(oldToken), 403, "leaving is still blocked by Gate 14");

      await nextSecond();
      local.employee_status = 1;
      local.token_valid_from = new Date(); // C1c bumped it

      assert.equal(
        await hit(oldToken),
        200,
        "the revoked token is accepted: AUTH_TOKEN_VALID_FROM_ENABLED must be on in production"
      );
    } finally {
      s.close();
    }
  });

  it("the default really is off, so this is a deployment prerequisite and not a theory", () => {
    delete require.cache[require.resolve("../config/auth")];
    const saved = process.env.AUTH_TOKEN_VALID_FROM_ENABLED;
    delete process.env.AUTH_TOKEN_VALID_FROM_ENABLED;
    const fresh = require("../config/auth");
    assert.equal(fresh.login.tokenValidFromEnabled, false);
    assert.equal(fresh.login.employeeStatusCheck, true, "leaving is blocked by default; rejoining is not");
    if (saved !== undefined) process.env.AUTH_TOKEN_VALID_FROM_ENABLED = saved;
    delete require.cache[require.resolve("../config/auth")];
  });
});
