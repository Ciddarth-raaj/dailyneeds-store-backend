/**
 * TELEGRAM WEB APP `initData` VALIDATION.
 *
 *   node --test utils/telegram_init_data.test.js
 *
 * This is the whole of the Mini App's identity, so it is tested as an
 * attacker would probe it: a forged hash, a user id changed after signing, a
 * payload replayed from yesterday, a payload with no user at all.
 *
 * No network, no database, no bot. Two kinds of payload are used, and the
 * difference matters:
 *
 *   PUBLISHED CAPTURES   real `initData` recorded from a Telegram client,
 *                        with the throwaway bot token that signed it, taken
 *                        from the `init-data-py` library's test vectors
 *                        (github.com/nimaxin/init-data-py,
 *                        tests/vectors.py). NOTHING IN THIS REPOSITORY
 *                        PRODUCED THESE HASHES, so they are the only thing
 *                        here that can prove the algorithm is Telegram's
 *                        rather than merely self-consistent. The `SIGNED`
 *                        capture carries BOTH `signature` and `hash` and is
 *                        what pins `signature` into the data-check-string.
 *
 *   `signInitData`       locally signed payloads, for the tampering and
 *                        freshness cases, where what is being tested is a
 *                        REJECTION and any correctly signed base will do.
 *
 * THE BOT TOKENS BELOW ARE NOT OURS. They are throwaway credentials
 * published with those vectors; the Daily Needs bot token appears nowhere in
 * this repository.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  validateInitData,
  signInitData,
  dataCheckString,
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

/* ===================================================================
 * PUBLISHED TELEGRAM CAPTURES
 * =================================================================== */

/**
 * Captured from a CURRENT Telegram client, so it carries `signature`
 * alongside `hash`. Its `auth_date` is 1788639560.
 *
 * Source: github.com/nimaxin/init-data-py, tests/vectors.py (`SIGNED`).
 * The bot token is the throwaway one published with the vector.
 */
const SIGNED_VECTOR = {
  initData:
    "user=%7B%22id%22%3A5167898484%2C%22first_name%22%3A%22xin%22%2C%22" +
    "last_name%22%3A%22%22%2C%22username%22%3A%22pvnimaxin%22%2C%22" +
    "language_code%22%3A%22en%22%2C%22allows_write_to_pm%22%3Atrue%2C%22" +
    "photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F" +
    "320%5C%2FYpcdHFmoxukmQ537mOZhe-Woot_k2xrmbdAIrGK1zFgIVth6Wzacz7P2nGN" +
    "Ccp9j.svg%22%7D&chat_instance=8207002646956202621&chat_type=private" +
    "&auth_date=1788639560&signature=5TpQXmcWfc12P3GMFaHQzBri6FNu6QWrkH4y" +
    "sQX3CuT0Jdh3LhOEjd0jvso0fnOa_YCpJXZiid-DpZXidvVPAQ&hash=2c450512f189" +
    "adbf7e7027e5f32fd7954c00fb21218265320b9a6b9c2139891f",
  botToken: "7082182952:AAFN9rxuCROAv-lBtSXSSaR3ZMQsP0KW95I",
  authDate: 1788639560,
  telegramUserId: 5167898484,
};

/**
 * An older capture with NO `signature`, so the same code must still accept a
 * payload from a client that never sends one.
 *
 * Source: the same file (`PLAIN`).
 */
const PLAIN_VECTOR = {
  initData:
    "query_id=AAF03wc0AgAAAHTfBzROOCVW&user=%7B%22id%22%3A5167898484%2C%22" +
    "first_name%22%3A%22xin%22%2C%22last_name%22%3A%22%22%2C%22username%22" +
    "%3A%22pvnimaxin%22%2C%22language_code%22%3A%22en%22%2C%22allows_write" +
    "_to_pm%22%3Atrue%7D&auth_date=1722938610&hash=8654c8c617c143abf656f4f" +
    "159be2539880a56f58c2d9be622f90c0346aa162b",
  botToken: "7244657541:AAEgqk0HDC3WD5cdbnGMdd6L0TJ74FDp97Y",
  authDate: 1722938610,
  telegramUserId: 5167898484,
};

describe("published Telegram captures", () => {
  /**
   * ============================ THE REGRESSION THIS FILE EXISTS FOR ========
   *
   * An earlier version of the validator dropped `signature` from the
   * data-check-string along with `hash`. Against a locally signed payload
   * that looks fine - the signer and the verifier agree. Against a REAL
   * capture it is a total outage: every current client sends `signature`,
   * every hash would differ, and every employee would be told Telegram could
   * not verify them.
   *
   * This asserts the published hash VERIFIES, and then asserts the
   * counterfactual explicitly: recomputing without `signature` produces a
   * different digest. Both halves have to hold for the test to mean anything.
   */
  it("accepts a real capture that carries BOTH signature and hash", () => {
    const out = validateInitData(SIGNED_VECTOR.initData, {
      botToken: SIGNED_VECTOR.botToken,
      nowSeconds: SIGNED_VECTOR.authDate + 30,
    });
    assert.equal(out.telegram_user_id, SIGNED_VECTOR.telegramUserId);
    assert.equal(out.auth_date, SIGNED_VECTOR.authDate);
    assert.equal(out.username, "pvnimaxin");
  });

  it("the published hash covers `signature` - dropping it gives a DIFFERENT digest", () => {
    const pairs = new Map();
    for (const chunk of SIGNED_VECTOR.initData.split("&")) {
      const eq = chunk.indexOf("=");
      pairs.set(chunk.slice(0, eq), decodeURIComponent(chunk.slice(eq + 1)));
    }
    const published = pairs.get("hash");
    assert.ok(pairs.has("signature"), "the vector really does carry a signature");

    const digest = (dcs) => {
      const secret = crypto.createHmac("sha256", "WebAppData").update(SIGNED_VECTOR.botToken).digest();
      return crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    };
    const lines = (exclude) =>
      [...pairs.entries()]
        .filter(([k]) => !exclude.has(k))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");

    // What our `dataCheckString` builds - and what Telegram actually signed.
    assert.equal(dataCheckString(pairs), lines(new Set(["hash"])));
    assert.equal(digest(lines(new Set(["hash"]))), published);

    // The old, wrong rule. It must NOT reproduce the published hash.
    assert.notEqual(digest(lines(new Set(["hash", "signature"]))), published);
  });

  it("still accepts an older capture that carries NO signature", () => {
    const out = validateInitData(PLAIN_VECTOR.initData, {
      botToken: PLAIN_VECTOR.botToken,
      nowSeconds: PLAIN_VECTOR.authDate + 30,
    });
    assert.equal(out.telegram_user_id, PLAIN_VECTOR.telegramUserId);
    assert.equal(out.auth_date, PLAIN_VECTOR.authDate);
  });

  it("a real capture presented to the WRONG bot token is refused", () => {
    assert.throws(
      () =>
        validateInitData(SIGNED_VECTOR.initData, {
          botToken: PLAIN_VECTOR.botToken,
          nowSeconds: SIGNED_VECTOR.authDate + 30,
        }),
      (err) => err.code === REJECT.BAD_SIGNATURE
    );
  });

  /**
   * A real capture is a real credential for as long as it is fresh. Replayed
   * later it is refused by the clock, not by the signature - which is why the
   * freshness window is not optional.
   */
  it("a real capture replayed long afterwards is refused as stale", () => {
    assert.throws(
      () =>
        validateInitData(SIGNED_VECTOR.initData, {
          botToken: SIGNED_VECTOR.botToken,
          nowSeconds: SIGNED_VECTOR.authDate + 86400,
        }),
      (err) => err.code === REJECT.STALE
    );
  });

  it("a real capture with its signature tampered with is refused", () => {
    const tampered = SIGNED_VECTOR.initData.replace("&signature=5TpQ", "&signature=6TpQ");
    assert.notEqual(tampered, SIGNED_VECTOR.initData);
    assert.throws(
      () =>
        validateInitData(tampered, {
          botToken: SIGNED_VECTOR.botToken,
          nowSeconds: SIGNED_VECTOR.authDate + 30,
        }),
      (err) => err.code === REJECT.BAD_SIGNATURE
    );
  });
});

describe("a genuine payload", () => {
  it("a locally signed payload carrying `signature` round-trips", () => {
    const withSig = signInitData(
      {
        user: user(501),
        auth_date: String(NOW),
        chat_instance: "8207002646956202621",
        signature: "5TpQXmcWfc12P3GMFaHQzBri6FNu6QWrkH4y",
      },
      BOT_TOKEN
    );
    assert.ok(/signature=/.test(withSig));
    assert.equal(
      validateInitData(withSig, { botToken: BOT_TOKEN, nowSeconds: NOW }).telegram_user_id,
      501
    );
  });

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
   * `signature` is a signed field like any other, so appending one to a
   * payload that did not have it is tampering and is refused. This is the
   * same assertion as the line above - stated separately because `signature`
   * is the field somebody would be tempted to treat as special.
   */
  it("a signature appended after signing is rejected like any other extra field", () => {
    rejectedWith(REJECT.BAD_SIGNATURE, `${signed()}&signature=AAAA`);
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
