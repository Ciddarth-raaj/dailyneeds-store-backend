/**
 * THE TELEGRAM ATTENDANCE MINI APP SESSION.
 *
 *   node --test usecase/telegram_attendance_session.test.js
 *
 * Real RS256 keys (generated here), the real `services/jwt.js`, the real
 * `utils/telegram_init_data.js`. Only the identity repository is a fake,
 * because a row in `employee_telegram_identity` is the one thing this needs
 * MySQL for.
 *
 * THE LOAD-BEARING TEST IN THIS FILE is the last suite: the token this
 * usecase mints is refused by `middlewares/auth.js#resolveIdentity`. That is
 * what makes "a Mini App session is not a dnds.co.in login" a fact about the
 * claim shape rather than a promise in a comment.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { createJwtService } = require("../services/jwt");
const { signInitData } = require("../utils/telegram_init_data");
const { resolveIdentity } = require("../middlewares/auth");
const buildSession = require("../usecase/telegram_attendance_session");

const BOT_TOKEN = "123456:AAH-test-bot-token";
const NOW_MS = 1_790_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const jwtService = createJwtService({
  privateKey,
  publicKeys: { test: publicKey },
  activeKid: "test",
  legacyKid: "test",
});

const initDataFor = (telegramUserId, authDate = NOW_S) =>
  signInitData(
    { user: JSON.stringify({ id: telegramUserId, first_name: "Asha" }), auth_date: String(authDate) },
    BOT_TOKEN
  );

/** `employee_telegram_identity`, faked with its own `disconnected_at IS NULL`. */
const fakeIdentityRepo = (rows = []) => ({
  getActiveIdentityByTelegramUser: async (telegramUserId) =>
    rows.find(
      (r) => Number(r.telegram_user_id) === Number(telegramUserId) && r.disconnected_at === null
    ) || null,
});

const build = (rows, overrides = {}) =>
  buildSession({
    identityRepo: fakeIdentityRepo(rows),
    jwtService,
    getBotToken: () => BOT_TOKEN,
    now: () => NOW_MS,
    ...overrides,
  });

const LINKED = { employee_id: 77, telegram_user_id: 501, disconnected_at: null };
const RETIRED = { employee_id: 88, telegram_user_id: 502, disconnected_at: "2026-09-01 10:00:00" };

const refusedWith = async (usecase, initData, code) => {
  await assert.rejects(
    () => usecase.exchange({ initData }),
    (err) => err.name === "TelegramAuthError" && (code ? err.code === code : true),
    `expected a refusal${code ? ` (${code})` : ""}`
  );
};

describe("exchanging signed initData", () => {
  it("a valid payload for a linked Telegram account yields a session for THAT employee", async () => {
    const usecase = build([LINKED]);
    const out = await usecase.exchange({ initData: initDataFor(501) });
    assert.equal(out.code, 200);
    assert.ok(typeof out.token === "string" && out.token.length > 0);
    // The employee is in the token's SIGNED claim, not in the body.
    assert.equal(await usecase.authenticate(out.token).then((s) => s.employee_id), 77);
    assert.equal(out.employee.employee_id, undefined);
    assert.ok(out.expires_in > 0 && out.expires_in <= 30 * 60, "the session is short-lived");
  });

  it("a forged hash is refused", async () => {
    const usecase = build([LINKED]);
    const forged = initDataFor(501).replace(/hash=[0-9a-f]{64}$/, `hash=${"b".repeat(64)}`);
    await refusedWith(usecase, forged, "INIT_DATA_BAD_SIGNATURE");
  });

  it("a Telegram user id changed after signing is refused", async () => {
    const usecase = build([LINKED, { employee_id: 99, telegram_user_id: 502, disconnected_at: null }]);
    const genuine = initDataFor(501);
    const swapped = genuine.replace(
      encodeURIComponent(JSON.stringify({ id: 501, first_name: "Asha" })),
      encodeURIComponent(JSON.stringify({ id: 502, first_name: "Asha" }))
    );
    await refusedWith(usecase, swapped, "INIT_DATA_BAD_SIGNATURE");
  });

  it("stale initData is refused", async () => {
    const usecase = build([LINKED]);
    await refusedWith(usecase, initDataFor(501, NOW_S - 100000), "INIT_DATA_STALE");
  });

  it("a payload with no Telegram user is refused", async () => {
    const usecase = build([LINKED]);
    const noUser = signInitData({ auth_date: String(NOW_S) }, BOT_TOKEN);
    await refusedWith(usecase, noUser, "INIT_DATA_NO_USER");
  });
});

describe("the employee mapping is the only authority", () => {
  it("a verified Telegram user with NO employee mapping is refused", async () => {
    const usecase = build([LINKED]);
    await refusedWith(usecase, initDataFor(777), "TELEGRAM_IDENTITY_NOT_LINKED");
  });

  it("a DISCONNECTED identity is refused - it is not a row this can find", async () => {
    const usecase = build([RETIRED]);
    await refusedWith(usecase, initDataFor(502), "TELEGRAM_IDENTITY_NOT_LINKED");
  });

  /**
   * There is no fallback to a mobile number, a username, a display name or a
   * group. The repository is asked ONE question, with ONE argument.
   */
  it("asks the repository by Telegram user id and by nothing else", async () => {
    const asked = [];
    const usecase = buildSession({
      identityRepo: {
        getActiveIdentityByTelegramUser: async (...args) => {
          asked.push(args);
          return LINKED;
        },
      },
      jwtService,
      getBotToken: () => BOT_TOKEN,
      now: () => NOW_MS,
    });
    await usecase.exchange({ initData: initDataFor(501) });
    assert.deepEqual(asked, [[501]]);
  });

  it("no bot token means no session, not an open door", async () => {
    const usecase = build([LINKED], { getBotToken: () => null });
    await refusedWith(usecase, initDataFor(501), "MINI_APP_NOT_CONFIGURED");
  });
});

describe("the scoped session token", () => {
  it("names exactly one employee, read from the signed claim", async () => {
    const usecase = build([LINKED]);
    const { token } = await usecase.exchange({ initData: initDataFor(501) });
    const session = await usecase.authenticate(token);
    assert.equal(session.employee_id, 77);
    assert.equal(session.telegram_user_id, 501);
    assert.ok(session.session_id);
  });

  it("authenticate() takes NO employee argument, so nothing can override it", () => {
    // One parameter: the token. There is no second one to pass an id to.
    assert.equal(build([LINKED]).authenticate.length, 1);
  });

  it("a garbled or absent token is refused", async () => {
    const usecase = build([LINKED]);
    await assert.rejects(() => usecase.authenticate(""), (e) => e.name === "TelegramAuthError");
    await assert.rejects(() => usecase.authenticate("not.a.token"), (e) => e.name === "TelegramAuthError");
    await assert.rejects(() => usecase.authenticate(undefined), (e) => e.name === "TelegramAuthError");
  });

  /**
   * A perfectly valid dnds.co.in login token verifies against the same key.
   * It must still not open the Mini App, because it carries no `scope`.
   */
  it("an ordinary dnds.co.in login token is refused here", async () => {
    const usecase = build([LINKED]);
    const loginToken = await jwtService.sign({ auth_ver: 2, sub: "12", id: 12, employee_id: 77 }, "1d");
    await assert.rejects(
      () => usecase.authenticate(loginToken),
      (err) => err.name === "TelegramAuthError" && err.code === "MINI_APP_SESSION_SCOPE"
    );
  });
});

/**
 * ======================= THE PROOF, IN BOTH DIRECTIONS ======================
 */
describe("a Mini App token is not a dnds.co.in session", () => {
  it("is refused by middlewares/auth.js#resolveIdentity", async () => {
    const usecase = build([LINKED]);
    const { token } = await usecase.exchange({ initData: initDataFor(501) });
    const decoded = await jwtService.verify(token);

    // The claim shape: none of the four claims the auth middleware can read.
    assert.equal(decoded.sub, undefined);
    assert.equal(decoded.id, undefined);
    assert.equal(decoded.employee_id, undefined);
    assert.equal(decoded.auth_ver, undefined);

    // And therefore no identity at all, which the middleware turns into 403.
    assert.equal(resolveIdentity(decoded), null);
  });

  it("carries no permission, designation, store or user type", async () => {
    const usecase = build([LINKED]);
    const { token } = await usecase.exchange({ initData: initDataFor(501) });
    const decoded = await jwtService.verify(token);
    assert.deepEqual(
      Object.keys(decoded).sort(),
      ["emp", "exp", "iat", "scope", "sid", "tgu"]
    );
  });

  it("expires quickly", async () => {
    const usecase = build([LINKED]);
    const { token, expires_in } = await usecase.exchange({ initData: initDataFor(501) });
    const decoded = await jwtService.verify(token);
    assert.equal(decoded.exp - decoded.iat, expires_in);
    assert.ok(expires_in <= 30 * 60);
  });
});

describe("the audit trail", () => {
  it("records the verified Telegram id, the employee and the session - and no secret", async () => {
    const lines = [];
    const usecase = build([LINKED], { log: { LEVEL: { INFO: "info" }, Log: (l) => lines.push(l) } });
    await usecase.exchange({ initData: initDataFor(501) });

    const issued = lines.find((l) => /SESSION-ISSUED/.test(l.code));
    assert.ok(issued, "a session issue is audited");
    assert.equal(issued.ref.telegram_user_id, 501);
    assert.equal(issued.ref.employee_id, 77);
    assert.ok(issued.ref.session_id);

    const all = JSON.stringify(lines);
    assert.ok(!all.includes(BOT_TOKEN), "the bot token is never logged");
    assert.ok(!/init_?data/i.test(all), "raw initData is never logged");
    assert.ok(!/hash/i.test(all), "the Telegram hash is never logged");
  });

  it("records a verified Telegram user that maps to nobody", async () => {
    const lines = [];
    const usecase = build([LINKED], { log: { LEVEL: { INFO: "info" }, Log: (l) => lines.push(l) } });
    await assert.rejects(() => usecase.exchange({ initData: initDataFor(777) }));
    assert.ok(lines.some((l) => /NO-MAPPING/.test(l.code) && l.ref.telegram_user_id === 777));
  });
});

/**
 * ============ END TO END: THE REAL AUTH MIDDLEWARE, THE REAL JWT SERVICE ===
 *
 * The suite above proves the claim shape through `resolveIdentity`. This one
 * proves the CONSEQUENCE: a Mini App token, minted by the real
 * `services/jwt` with the repository's own key, presented to the real
 * `middlewares/auth.js` as `x-access-token`, is refused 403 - exactly as an
 * unauthenticated request is.
 *
 * It uses the tracked key pair rather than the generated one above, because
 * the middleware resolves its verification key from configuration and must
 * be able to verify the token before it can decide to refuse it. A token it
 * could not even verify would prove nothing about the claim shape.
 */
describe("a Mini App token on an ordinary route", () => {
  const realJwt = require("../services/jwt");
  const authMiddleware = require("../middlewares/auth");

  const runMiddleware = (headers, pathName = "/attendance/me", method = "GET") =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          resolve({ status: this.statusCode, body: payload, passed: false });
          return this;
        },
        end() {},
      };
      authMiddleware({ headers, path: pathName, method }, res, () =>
        resolve({ status: 200, body: null, passed: true })
      );
    });

  it("is refused 403 - it is not a dnds.co.in session", async () => {
    const usecase = buildSession({
      identityRepo: fakeIdentityRepo([LINKED]),
      jwtService: realJwt,
      getBotToken: () => BOT_TOKEN,
      now: () => NOW_MS,
    });
    const { token } = await usecase.exchange({ initData: initDataFor(501) });

    // The token really is valid and really does name employee 77...
    assert.equal((await usecase.authenticate(token)).employee_id, 77);

    // ...and the ordinary middleware still refuses it.
    const out = await runMiddleware({ "x-access-token": token });
    assert.equal(out.passed, false, "the request must not reach the route");
    assert.equal(out.body.code, 403);
  });

  it("an ordinary employee token on the same route is NOT refused - the test can tell them apart", async () => {
    const loginToken = await realJwt.sign(
      { auth_ver: 2, sub: "12", id: 12, employee_id: 77, user_type: 1 },
      "1d"
    );
    const out = await runMiddleware({ "x-access-token": loginToken });
    assert.equal(out.passed, true, "a real session token passes the same middleware");
  });

  it("no token is refused the same way, so 403 is the honest comparison", async () => {
    const out = await runMiddleware({});
    assert.equal(out.passed, false);
    assert.equal(out.body.code, 403);
  });
});
