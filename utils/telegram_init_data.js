/**
 * TELEGRAM WEB APP `initData` - THE SIGNATURE CHECK, in one pure place.
 *
 * ============================================ WHY THIS FILE EXISTS ALONE ===
 *
 * A Telegram Mini App runs in a WebView the employee controls. Everything it
 * sends - the URL, the query string, the request body, the Telegram username
 * it believes it has - is attacker-controlled. The ONE thing that is not is
 * `initData`: a query string Telegram itself signs with a key derived from
 * the bot token, which only the server holds.
 *
 * So identity for the Attendance Mini App is decided HERE and nowhere else,
 * and this file is deliberately pure: no database, no clock, no environment,
 * no logging. The bot token and "now" are arguments. That is what lets the
 * forged-hash, tampered-user-id and stale-initData cases be tested without a
 * bot, a browser or a server.
 *
 * ===================================== THE ALGORITHM, AS TELEGRAM WRITES IT
 *
 *   1. take the `initData` query string exactly as Telegram handed it over
 *   2. remove the `hash` field; keep every other field VERBATIM (already
 *      percent-decoded once, values untouched - `user` stays the JSON text
 *      it is, because that text is what was signed)
 *   3. sort the remaining `key=value` lines by key and join them with "\n"
 *      -> the data-check-string
 *   4. secret_key = HMAC_SHA256(key: "WebAppData", message: bot_token)
 *   5. expected  = HMAC_SHA256(key: secret_key,   message: data-check-string)
 *   6. compare hex(expected) with the supplied `hash` in CONSTANT TIME
 *
 * `signature` IS EXCLUDED from the data-check-string as well. It is the
 * newer Ed25519 third-party signature; it is not part of what the HMAC
 * covers, and leaving it in makes every genuine payload fail.
 *
 * ======================================================= FRESHNESS =========
 *
 * A valid signature is forever. `initData` captured from one employee's
 * device would otherwise be a permanent credential for that employee, so
 * `auth_date` must be recent - `DEFAULT_MAX_AGE_SECONDS` below. Clock skew
 * in the other direction is bounded too: an `auth_date` in the future beyond
 * a small tolerance is refused rather than treated as maximally fresh.
 *
 * ======================================================= WHAT IS NEVER DONE
 *
 * Nothing here is logged, and the return value carries NO hash, NO raw
 * initData and NO bot token. `telegram_user_id` and `auth_date` are the only
 * things a caller gets to keep - the username and display name are returned
 * for nothing but a greeting, and are NEVER an identity anywhere.
 */

const crypto = require("crypto");

/** How old signed `initData` may be. Five minutes: a Mini App opens at once. */
const DEFAULT_MAX_AGE_SECONDS = 300;

/** Tolerance for a device clock that runs fast. Not a second more. */
const FUTURE_SKEW_SECONDS = 60;

/** Why validation failed. Short codes - never the hash, never the payload. */
const REJECT = Object.freeze({
  MISSING: "INIT_DATA_MISSING",
  MALFORMED: "INIT_DATA_MALFORMED",
  NO_HASH: "INIT_DATA_NO_HASH",
  BAD_SIGNATURE: "INIT_DATA_BAD_SIGNATURE",
  STALE: "INIT_DATA_STALE",
  NO_AUTH_DATE: "INIT_DATA_NO_AUTH_DATE",
  NO_USER: "INIT_DATA_NO_USER",
  BOT_TOKEN_MISSING: "TELEGRAM_BOT_TOKEN_MISSING",
});

/** `hash` and `signature` are the proof, not part of what was signed. */
const NOT_SIGNED = new Set(["hash", "signature"]);

class InitDataError extends Error {
  constructor(code) {
    super(code);
    this.name = "InitDataError";
    this.code = code;
  }
}

/**
 * Pairs, in arrival order, decoded exactly once.
 *
 * Hand-rolled rather than `URLSearchParams` for one reason: a duplicate key.
 * `URLSearchParams.get` silently keeps the first, which would let somebody
 * append a second `user=` that the signature does not cover and that a naive
 * reader would prefer. Here a repeated key is MALFORMED and the whole payload
 * is refused.
 */
function parsePairs(initData) {
  if (typeof initData !== "string" || initData.trim() === "") {
    throw new InitDataError(REJECT.MISSING);
  }
  if (initData.length > 8192) throw new InitDataError(REJECT.MALFORMED);

  const out = new Map();
  for (const chunk of initData.split("&")) {
    if (chunk === "") continue;
    const eq = chunk.indexOf("=");
    if (eq <= 0) throw new InitDataError(REJECT.MALFORMED);
    const key = chunk.slice(0, eq);
    let value;
    try {
      value = decodeURIComponent(chunk.slice(eq + 1).replace(/\+/g, " "));
    } catch (err) {
      throw new InitDataError(REJECT.MALFORMED);
    }
    if (out.has(key)) throw new InitDataError(REJECT.MALFORMED);
    out.set(key, value);
  }
  if (out.size === 0) throw new InitDataError(REJECT.MALFORMED);
  return out;
}

/** Step 3: the data-check-string. */
function dataCheckString(pairs) {
  return [...pairs.entries()]
    .filter(([key]) => !NOT_SIGNED.has(key))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Steps 4 and 5. */
function expectedHash(dcs, botToken) {
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  return crypto.createHmac("sha256", secret).update(dcs).digest("hex");
}

/** Step 6. Lengths are compared first so `timingSafeEqual` cannot throw. */
function hashesMatch(supplied, expected) {
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * A Telegram user id is a positive integer. It arrives inside signed JSON, so
 * it cannot be tampered with - but it is still parsed strictly rather than
 * coerced, because a `user` object without a usable `id` is not an identity.
 */
function readUser(pairs) {
  const raw = pairs.get("user");
  if (raw === undefined) throw new InitDataError(REJECT.NO_USER);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InitDataError(REJECT.NO_USER);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InitDataError(REJECT.NO_USER);
  }
  const id = Number(parsed.id);
  if (!Number.isInteger(id) || id <= 0) throw new InitDataError(REJECT.NO_USER);
  return {
    telegram_user_id: id,
    // A greeting, never an identity. Nothing downstream may match on these.
    first_name: typeof parsed.first_name === "string" ? parsed.first_name : null,
    username: typeof parsed.username === "string" ? parsed.username : null,
  };
}

/**
 * Validate signed `initData`.
 *
 * @param {string} initData          the raw query string, verbatim
 * @param {object} options
 * @param {string} options.botToken  the bot credential. Never logged, never returned.
 * @param {number} [options.nowSeconds]      unix seconds; injected in tests
 * @param {number} [options.maxAgeSeconds]
 * @returns {{telegram_user_id:number, auth_date:number, first_name:?string, username:?string}}
 * @throws {InitDataError} with a short `.code` from REJECT
 */
function validateInitData(initData, options = {}) {
  const botToken = options.botToken;
  if (typeof botToken !== "string" || botToken === "") {
    throw new InitDataError(REJECT.BOT_TOKEN_MISSING);
  }
  const maxAge = Number.isFinite(options.maxAgeSeconds)
    ? Number(options.maxAgeSeconds)
    : DEFAULT_MAX_AGE_SECONDS;
  const now = Number.isFinite(options.nowSeconds)
    ? Number(options.nowSeconds)
    : Math.floor(Date.now() / 1000);

  const pairs = parsePairs(initData);

  const supplied = pairs.get("hash");
  if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/i.test(supplied)) {
    throw new InitDataError(REJECT.NO_HASH);
  }

  // THE SIGNATURE IS CHECKED BEFORE ANY FIELD IS READ AS MEANINGFUL. Nothing
  // below this line trusts a value that has not been proven signed.
  if (!hashesMatch(supplied.toLowerCase(), expectedHash(dataCheckString(pairs), botToken))) {
    throw new InitDataError(REJECT.BAD_SIGNATURE);
  }

  const authDate = Number(pairs.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) throw new InitDataError(REJECT.NO_AUTH_DATE);
  if (now - authDate > maxAge) throw new InitDataError(REJECT.STALE);
  if (authDate - now > FUTURE_SKEW_SECONDS) throw new InitDataError(REJECT.STALE);

  const user = readUser(pairs);
  return { ...user, auth_date: authDate };
}

/**
 * TEST SUPPORT, and nothing else uses it: build correctly signed `initData`
 * for a given bot token. It is the same code path as verification, which is
 * the point - a test that hand-rolled the HMAC would prove only that two
 * copies of the same mistake agree.
 */
function signInitData(fields, botToken) {
  const pairs = new Map(Object.entries(fields));
  const hash = expectedHash(dataCheckString(pairs), botToken);
  const parts = [...pairs.entries()].map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  );
  parts.push(`hash=${hash}`);
  return parts.join("&");
}

module.exports = {
  DEFAULT_MAX_AGE_SECONDS,
  FUTURE_SKEW_SECONDS,
  REJECT,
  InitDataError,
  validateInitData,
  signInitData,
  dataCheckString,
};
