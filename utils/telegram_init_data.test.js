/**
 * TELEGRAM WEB APP `initData` VALIDATION.
 *
 *   node --test utils/telegram_init_data.test.js
 *
 * This is the whole of the Mini App's identity, so it is tested as an
 * attacker would probe it: a forged hash, a user id changed after signing, a
 * payload replayed from yesterday, a payload with no user at all.
 *
 * No network, no database, no bot. `signInitData` produces genuinely signed
 * payloads for a throwaway token.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateInitData,
  signInitData,
  REJECT,
  DEFAULT_MAX_AGE_SECONDS,
} = require("../utils/telegram_init_data");

const BOT_TOKEN = "123456:AAH-test-bot-token-not-a-real-one";
const OTHER_TOKEN = "999999:AAH-a-different-bot-entirely";
const NOW = 1_790_000_000; // unix seconds, pinned

const user = (id, extra = {}) => JSON.stringify({ id, first_name: "Asha", ...extra });

const signed = ({ id = 501, authDate = NOW, token = BOT_TOKEN, ...rest } = {}) =>
  signInitData(
    { query_id: "AAE_test", user: user(id), auth_date: String(authDate), ...rest },
    token
  );

const rejectedWith = (code, initData, options = {}) => {
  assert.throws(
    () => validateInitData(initData, { botToken: BOT_TOKEN, nowSeconds: NOW, ...options }),
    (err) => err.name === "InitDataError" && err.code === code,
    `expected ${code}`
  );
};

describe("a genuine payload", () => {
  it("is accepted and yields the Telegram user id", () => {
    const out = validateInitData(signed({ id: 501 }), { botToken: BOT_TOKEN, nowSeconds: NOW });
    assert.equal(out.telegram_user_id, 501);
    assert.equal(out.auth_date, NOW);
  });

  it("returns NO hash, NO raw initData and NO bot token", () => {
    const out = validateInitData(signed(), { botToken: BOT_TOKEN, nowSeconds: NOW });
    const text = JSON.stringify(out);
    assert.deepEqual(Object.keys(out).sort(), ["auth_date", "first_name", "telegram_user_id", "username"]);
    assert.ok(!text.includes(BOT_TOKEN));
    assert.ok(!/hash/i.test(text));
  });
});

describe("a forged or tampered payload", () => {
  it("a forged hash is rejected", () => {
    const tampered = signed().replace(/hash=[0-9a-f]{64}$/, `hash=${"a".repeat(64)}`);
    rejectedWith(REJECT.BAD_SIGNATURE, tampered);
  });

  /**
   * THE CASE THE WHOLE FEATURE TURNS ON. Sign as user 501, then edit the
   * `user` field to 502 and keep the signature. If this ever passed, one
   * employee could file corrections on another's attendance.
   */
  it("a Telegram user id changed AFTER signing is rejected", () => {
    const genuine = signed({ id: 501 });
    const swapped = genuine.replace(
      encodeURIComponent(user(501)),
      encodeURIComponent(user(502))
    );
    assert.notEqual(swapped, genuine);
    rejectedWith(REJECT.BAD_SIGNATURE, swapped);
  });

  it("a payload signed by a DIFFERENT bot is rejected", () => {
    rejectedWith(REJECT.BAD_SIGNATURE, signed({ token: OTHER_TOKEN }));
  });

  it("an extra field appended after signing is rejected", () => {
    rejectedWith(REJECT.BAD_SIGNATURE, `${signed()}&employee_id=9`);
  });

  /**
   * A DUPLICATE KEY IS MALFORMED, not "the first one wins". A second `user=`
   * is exactly how somebody would try to shadow the signed one.
   */
  it("a duplicated field is refused outright", () => {
    const genuine = signed({ id: 501 });
    rejectedWith(REJECT.MALFORMED, `${genuine}&user=${encodeURIComponent(user(502))}`);
  });

  it("no hash at all is rejected", () => {
    rejectedWith(REJECT.NO_HASH, signed().replace(/&hash=[0-9a-f]{64}$/, ""));
  });

  it("empty or absent initData is rejected", () => {
    rejectedWith(REJECT.MISSING, "");
    rejectedWith(REJECT.MISSING, undefined);
    rejectedWith(REJECT.MISSING, null);
  });
});

describe("freshness", () => {
  it("initData older than the freshness window is rejected", () => {
    const stale = signed({ authDate: NOW - DEFAULT_MAX_AGE_SECONDS - 1 });
    rejectedWith(REJECT.STALE, stale);
  });

  it("initData inside the window is accepted", () => {
    const fresh = signed({ authDate: NOW - DEFAULT_MAX_AGE_SECONDS + 5 });
    assert.equal(
      validateInitData(fresh, { botToken: BOT_TOKEN, nowSeconds: NOW }).telegram_user_id,
      501
    );
  });

  it("an auth_date far in the future is rejected rather than treated as fresh", () => {
    rejectedWith(REJECT.STALE, signed({ authDate: NOW + 3600 }));
  });
});

describe("the user", () => {
  it("a payload with no user is rejected - there is nobody to be", () => {
    const noUser = signInitData({ query_id: "AAE", auth_date: String(NOW) }, BOT_TOKEN);
    rejectedWith(REJECT.NO_USER, noUser);
  });

  it("a signed user without a usable id is rejected", () => {
    const badId = signInitData(
      { user: JSON.stringify({ first_name: "Asha" }), auth_date: String(NOW) },
      BOT_TOKEN
    );
    rejectedWith(REJECT.NO_USER, badId);
  });

  it("a username is carried for a greeting and is never the identity", () => {
    const withName = signInitData(
      { user: user(501, { username: "asha" }), auth_date: String(NOW) },
      BOT_TOKEN
    );
    const out = validateInitData(withName, { botToken: BOT_TOKEN, nowSeconds: NOW });
    assert.equal(out.username, "asha");
    assert.equal(out.telegram_user_id, 501);
  });
});

describe("configuration", () => {
  it("no bot token means no validation, not a pass", () => {
    assert.throws(
      () => validateInitData(signed(), { botToken: null, nowSeconds: NOW }),
      (err) => err.code === REJECT.BOT_TOKEN_MISSING
    );
  });
});
