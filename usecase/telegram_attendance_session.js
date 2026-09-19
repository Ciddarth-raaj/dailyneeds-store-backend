/**
 * THE TELEGRAM ATTENDANCE MINI APP SESSION.
 *
 * ================================================= WHAT DECIDES THE EMPLOYEE
 *
 * ONLY THIS FILE, and it has exactly one input it trusts: `initData` signed
 * by Telegram with a key derived from the bot token
 * (`utils/telegram_init_data.js`). From the signed payload it takes ONE
 * value - the Telegram `user.id` - and looks it up in
 * `employee_telegram_identity` where `disconnected_at IS NULL`. That row is
 * the employee.
 *
 * THERE IS NO SECOND WAY IN. Not a mobile number, not a Telegram username,
 * not a display name, not a query-string `employee_id`, not a body
 * `employee_id`, not group membership. No mapping is a refusal; a
 * disconnected mapping is a refusal. Neither is guessed around, because the
 * only thing worse than an employee who cannot file a correction is an
 * employee who files one against somebody else's attendance.
 *
 * ========================================== WHY A TOKEN AND NOT initData ===
 *
 * Re-validating `initData` on every call would work, but it would mean the
 * signed payload travelling on every request and a five-minute-old Mini App
 * silently dying mid-form. Instead the signature is spent ONCE, at
 * `/telegram/attendance/session`, and exchanged for a token that says one
 * thing: "this is employee N, inside the Telegram Attendance Mini App, for
 * the next few minutes".
 *
 * ========================= WHY THIS TOKEN CAN NEVER BE A dnds.co.in SESSION
 *
 * It is signed with the same key as an ordinary token, and it is STILL
 * refused by `middlewares/auth.js`, by construction rather than by a check
 * somebody has to remember to write:
 *
 *   `middlewares/auth.js#resolveIdentity` accepts exactly two claim shapes.
 *   `auth_ver: 2` requires a string `sub`; the legacy shape requires a
 *   positive-integer `id` AND a positive-integer `employee_id`. THIS TOKEN
 *   CARRIES NONE OF THOSE FOUR CLAIMS - no `sub`, no `id`, no `employee_id`,
 *   no `auth_ver`. It falls into the legacy branch, fails `isPositiveInt`
 *   on the absent `id`, and resolves to `null`, which is an outright 403.
 *
 * So the worst a leaked Mini App token can do is what the Mini App itself
 * can do: read that one employee's own missing dates and file that one
 * employee's own regularization. It grants no permission key, reaches no HR
 * route, and names no other employee anywhere - `employee_id` is carried in
 * the signed claim and is never read from a request.
 *
 * ====================================================== WHAT IS AUDITED ====
 *
 * Session issue and session use are logged as: which verified Telegram user
 * id, which employee it mapped to, which session id, and when. The bot
 * token, the raw `initData` and the Telegram hash are NEVER logged - and
 * cannot be, because `validateInitData` does not return them.
 */

const crypto = require("crypto");
const initDataUtil = require("../utils/telegram_init_data");

/**
 * The audience of this token, checked on every call. A token minted for
 * anything else - now or later - is refused here even though it verifies.
 */
const SCOPE = "telegram_attendance_miniapp";

/** Short-lived on purpose. Long enough to fill one form, not to keep. */
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;

const COMPONENT = "USECASE.TELEGRAM-ATTENDANCE-SESSION";

const REJECT = Object.freeze({
  NO_EMPLOYEE_MAPPING: "TELEGRAM_IDENTITY_NOT_LINKED",
  SESSION_INVALID: "MINI_APP_SESSION_INVALID",
  SESSION_SCOPE: "MINI_APP_SESSION_SCOPE",
  NOT_CONFIGURED: "MINI_APP_NOT_CONFIGURED",
});

/** A 401 that names a short code and never a detail an attacker can use. */
function unauthorized(code, message) {
  const err = new Error(message || "Telegram authentication failed");
  err.name = "TelegramAuthError";
  err.code = code;
  err.status = 401;
  return err;
}

/**
 * @param {object} deps
 * @param {object} deps.identityRepo   repository/employee_telegram.js
 * @param {object} deps.jwtService     services/jwt.js (sign/verify)
 * @param {function():?string} deps.getBotToken  read lazily; never stored here
 * @param {number} [deps.ttlSeconds]
 * @param {number} [deps.maxInitDataAgeSeconds]
 * @param {function():number} [deps.now]   ms, injected in tests
 * @param {object} [deps.log]   anything with `.Log`/`.LEVEL` (utils/logger.js).
 *   Injected rather than required, so this file - and its tests - need no
 *   winston and no other dependency than node's own crypto.
 */
module.exports = ({
  identityRepo,
  jwtService,
  getBotToken,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  maxInitDataAgeSeconds = initDataUtil.DEFAULT_MAX_AGE_SECONDS,
  now = () => Date.now(),
  log = null,
}) => {
  const audit = (code, description, ref) => {
    if (log && typeof log.Log === "function") {
      log.Log({
        level: (log.LEVEL && log.LEVEL.INFO) || "info",
        component: COMPONENT,
        code: `${COMPONENT}.${code}`,
        description,
        category: "",
        ref,
      });
    }
  };

  /**
   * Exchange signed `initData` for a scoped Mini App session.
   *
   * Order matters and is not negotiable: SIGNATURE first, then freshness,
   * then the employee mapping. Nothing about the employee is read until
   * Telegram's signature has proven who the Telegram user is.
   */
  const exchange = async ({ initData }) => {
    const botToken = typeof getBotToken === "function" ? getBotToken() : null;
    if (!botToken) throw unauthorized(REJECT.NOT_CONFIGURED, "Telegram is not configured");

    let verified;
    try {
      verified = initDataUtil.validateInitData(initData, {
        botToken,
        maxAgeSeconds: maxInitDataAgeSeconds,
        nowSeconds: Math.floor(now() / 1000),
      });
    } catch (err) {
      // The CODE is kept; the payload is not, and never was.
      throw unauthorized(err.code || "INIT_DATA_INVALID", "Telegram authentication failed");
    }

    const telegramUserId = verified.telegram_user_id;

    // THE MAPPING IS THE AUTHORITY. The query itself carries
    // `disconnected_at IS NULL`, so a retired identity is not a row that
    // then gets filtered in JavaScript - it is not a row at all.
    const identity = await identityRepo.getActiveIdentityByTelegramUser(telegramUserId);
    if (!identity) {
      audit("NO-MAPPING", "verified Telegram user has no active employee identity", {
        telegram_user_id: telegramUserId,
      });
      throw unauthorized(
        REJECT.NO_EMPLOYEE_MAPPING,
        "This Telegram account is not linked to an employee. Please contact HR."
      );
    }

    const employeeId = Number(identity.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw unauthorized(REJECT.NO_EMPLOYEE_MAPPING, "This Telegram account is not linked to an employee.");
    }

    // A session id so a later submission can be tied back to the session
    // that produced it without either of them carrying a Telegram hash.
    const sessionId = crypto.randomBytes(12).toString("hex");

    const token = await jwtService.sign(
      {
        // Deliberately NONE of `sub`, `id`, `employee_id`, `auth_ver` - see
        // the header. `emp` is the employee and is readable only by this
        // file's own verifier.
        scope: SCOPE,
        emp: employeeId,
        tgu: telegramUserId,
        sid: sessionId,
      },
      ttlSeconds
    );

    audit("SESSION-ISSUED", "Telegram Attendance Mini App session issued", {
      telegram_user_id: telegramUserId,
      employee_id: employeeId,
      session_id: sessionId,
      expires_in: ttlSeconds,
    });

    return {
      code: 200,
      token,
      expires_in: ttlSeconds,
      session_id: sessionId,
      // NO `employee_id`. The browser has no use for one and must never be
      // in a position to send one back; the id lives in the token's SIGNED
      // `emp` claim, which the server reads and the client cannot alter, and
      // in the audit log above.
      employee: {
        // For the greeting line only. It is NOT an identity and nothing
        // downstream matches on it.
        first_name: verified.first_name,
      },
    };
  };

  /**
   * Verify a Mini App session token and return the ONE employee it names.
   *
   * Everything about the answer comes from the signed claim. There is no
   * argument for an employee id, so there is nothing for a request to
   * override.
   */
  const authenticate = async (token) => {
    if (typeof token !== "string" || token === "") {
      throw unauthorized(REJECT.SESSION_INVALID, "Session expired. Please reopen from Telegram.");
    }
    let decoded;
    try {
      decoded = await jwtService.verify(token);
    } catch (err) {
      throw unauthorized(REJECT.SESSION_INVALID, "Session expired. Please reopen from Telegram.");
    }
    if (!decoded || decoded.scope !== SCOPE) {
      // An ordinary dnds.co.in login token verifies perfectly well and has
      // no `scope`. It must not open this door either.
      throw unauthorized(REJECT.SESSION_SCOPE, "Session expired. Please reopen from Telegram.");
    }
    const employeeId = Number(decoded.emp);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw unauthorized(REJECT.SESSION_INVALID, "Session expired. Please reopen from Telegram.");
    }
    return {
      employee_id: employeeId,
      telegram_user_id: Number(decoded.tgu) || null,
      session_id: typeof decoded.sid === "string" ? decoded.sid : null,
      issued_at: decoded.iat || null,
    };
  };

  return { SCOPE, REJECT, DEFAULT_SESSION_TTL_SECONDS, exchange, authenticate, audit };
};

module.exports.SCOPE = SCOPE;
module.exports.REJECT = REJECT;
module.exports.DEFAULT_SESSION_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;
