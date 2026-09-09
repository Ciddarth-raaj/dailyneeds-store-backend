const axios = require("axios");
const logger = require("../utils/logger");
const kycConfig = require("../config/sandbox_kyc");

/**
 * Stage 0C / C2 — the shared Sandbox transport.
 *
 *   Sandbox auth (services/sandbox.js)
 *         ├── GST      (unchanged)
 *         ├── Aadhaar  (services/sandbox_aadhaar.js)
 *         └── Bank     (services/sandbox_bank.js)
 *
 * IT BORROWS THE LIVE SandboxService RATHER THAN AUTHENTICATING AGAIN.
 * `services/sandbox.js` already owns the `/authenticate` call, the decoded
 * JWT expiry, the five-minute refresh buffer and the single-flight refresh
 * promise. Building a second token cache here would mean two tokens, two
 * refresh races, and two things to get wrong; instead this asks that service
 * for a token and tells it to drop the token on a 401. GST behaviour is not
 * touched at all - not one line of the GST path runs through here.
 *
 * WHAT IT ADDS, once, for both new products: the request shape Sandbox
 * expects, a single 401 retry, a timeout, and - the important part - error
 * mapping that turns a provider response into a stable internal category
 * without ever letting a provider payload, header or stack reach a caller or
 * a log.
 */

/** Stable internal categories. Callers switch on these, never on provider text. */
const FAILURE = {
  NOT_CONFIGURED: "provider_not_configured",
  AUTH_FAILED: "provider_auth_failed",
  NOT_ENTITLED: "product_not_enabled",
  TIMEOUT: "provider_timeout",
  UNAVAILABLE: "provider_unavailable",
  RATE_LIMITED: "provider_rate_limited",
  INVALID_REQUEST: "provider_rejected_request",
  NOT_FOUND: "not_found",
  UNEXPECTED: "provider_unexpected_response",
};

/**
 * A provider failure, carrying a category and a message safe to show a user.
 * The raw provider payload is deliberately NOT attached: anything attached to
 * an Error tends to end up in a log eventually.
 */
class SandboxError extends Error {
  constructor(category, message, httpCode = 502) {
    super(message);
    this.name = "SandboxError";
    this.category = category;
    this.httpCode = httpCode;
  }
}

/**
 * The few provider strings worth showing a human, by category. Anything not
 * listed collapses to a generic message, so a provider cannot dictate what we
 * print.
 */
const SAFE_MESSAGE = {
  [FAILURE.NOT_CONFIGURED]: "The verification provider is not configured on this server",
  [FAILURE.AUTH_FAILED]: "The verification provider rejected our credentials",
  [FAILURE.NOT_ENTITLED]: "This verification product is not enabled on the provider account",
  [FAILURE.TIMEOUT]: "The verification provider did not respond in time",
  [FAILURE.UNAVAILABLE]: "The verification provider is unavailable",
  [FAILURE.RATE_LIMITED]: "The verification provider is rate limiting requests; try again shortly",
  [FAILURE.INVALID_REQUEST]: "The verification provider rejected the request",
  [FAILURE.NOT_FOUND]: "The verification provider found no matching record",
  [FAILURE.UNEXPECTED]: "The verification provider returned an unexpected response",
};

class SandboxClient {
  /**
   * @param {object} sandboxService the live services/sandbox.js instance
   * @param {object} [options.http] the HTTP transport; axios in production,
   *   replaced in tests so that no test can ever reach a real Sandbox endpoint.
   */
  constructor(sandboxService, options = {}) {
    this.sandbox = sandboxService || null;
    this.http = options.http || axios;
  }

  isEnabled() {
    return Boolean(this.sandbox && this.sandbox.isEnabled && this.sandbox.isEnabled());
  }

  _assertEnabled() {
    if (!this.isEnabled()) {
      throw new SandboxError(FAILURE.NOT_CONFIGURED, SAFE_MESSAGE[FAILURE.NOT_CONFIGURED], 503);
    }
  }

  /**
   * Maps an HTTP status and body onto a category. Sandbox answers 200 with a
   * `code` in the body as well, so both are considered - a 200 carrying
   * `code: 401` is still an auth failure.
   */
  static classify(status, body) {
    const code = body && typeof body === "object" && Number.isFinite(Number(body.code)) ? Number(body.code) : status;
    if (code === 401) return FAILURE.AUTH_FAILED;
    if (code === 402 || code === 403) return FAILURE.NOT_ENTITLED;
    if (code === 404) return FAILURE.NOT_FOUND;
    if (code === 408 || code === 504) return FAILURE.TIMEOUT;
    if (code === 429) return FAILURE.RATE_LIMITED;
    if (code === 400 || code === 422) return FAILURE.INVALID_REQUEST;
    if (code >= 500) return FAILURE.UNAVAILABLE;
    return FAILURE.UNEXPECTED;
  }

  /**
   * One Sandbox call.
   *
   * `logRef` is what may be written to the log - ids and categories only. The
   * request body and the response payload are never logged, because between
   * them they carry an Aadhaar number, an OTP, a bank account and a person's
   * address.
   *
   * `rawResponse` opts ONE call into accepting a bare JSON object at HTTP 200
   * as the answer. Sandbox wraps most products in `{ code, data }` but returns
   * the IFSC record itself; without this such a response would be classified
   * as unexpected and a perfectly valid branch code would look broken. It is
   * deliberately per-request: Aadhaar and Penny-Less rely on `code: 200`
   * meaning success, and relaxing that globally would let an error body
   * missing its envelope read as a good result on the paid paths.
   */
  async request({ method, path, body = null, logRef = {}, rawResponse = false }) {
    this._assertEnabled();

    const url = `${this.sandbox.baseUrl}${path}`;
    const send = async () => {
      const token = await this.sandbox.getAccessToken();
      return this.http({
        method,
        url,
        ...(body === null ? {} : { data: body }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          // Raw JWT, no "Bearer" - the same convention the GST calls use.
          Authorization: token,
          "x-api-key": this.sandbox.apiKey,
          "x-api-version": kycConfig.apiVersion,
        },
        timeout: kycConfig.timeoutMs,
        validateStatus: () => true,
      });
    };

    let res;
    try {
      res = await send();
      if (res.status === 401) {
        // The token may simply have aged out; drop it and try once more.
        this.sandbox.invalidateAccessToken();
        res = await send();
      }
    } catch (err) {
      const timedOut = err && (err.code === "ECONNABORTED" || /timeout/i.test(err.message || ""));
      const category = timedOut ? FAILURE.TIMEOUT : FAILURE.UNAVAILABLE;
      this._log(category, path, logRef);
      throw new SandboxError(category, SAFE_MESSAGE[category]);
    }

    const body_ = res.data;
    const isObject = body_ && typeof body_ === "object";
    // Some products answer with the `{ code, data }` envelope; the IFSC lookup
    // answers with the record itself. `envelope` distinguishes them by what
    // actually arrived rather than by which caller asked, so an endpoint that
    // sends one shape today and the other tomorrow needs no change here.
    const envelope = isObject && Number.isFinite(Number(body_.code));

    // A NARROW EXEMPTION, AND ONLY FOR CALLERS THAT ASK FOR IT.
    //
    // Aadhaar and Penny-Less depend on `code: 200` meaning success, and
    // loosening that for everybody would mean an error body missing its
    // envelope silently read as a good result on the paid paths. So the
    // exemption is per request: `rawResponse` says "a bare object at HTTP 200
    // is the answer here".
    //
    // Even then an ENVELOPE STILL WINS: a body carrying `code: 404` is a
    // not-found whether or not the caller expected raw JSON, so a provider
    // error can never be mistaken for a record.
    const ok =
      res.status === 200 && isObject && (envelope ? Number(body_.code) === 200 : Boolean(rawResponse));

    if (!ok) {
      const category = SandboxClient.classify(res.status, body_);
      this._log(category, path, { ...logRef, http_status: res.status });
      throw new SandboxError(category, SAFE_MESSAGE[category], category === FAILURE.NOT_ENTITLED ? 503 : 502);
    }

    if (!envelope) {
      // The record is the body. There is no transaction id to report, and
      // inventing one would be worse than admitting there is none.
      return { data: body_, transaction_id: null, timestamp: null };
    }

    return {
      data: body_.data || {},
      transaction_id: body_.transaction_id || null,
      timestamp: body_.timestamp || null,
    };
  }

  /** Category, path and safe ids. Never a payload. */
  _log(category, path, ref) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "SERVICE.SANDBOX_CLIENT",
      code: `SERVICE.SANDBOX_CLIENT.${category.toUpperCase()}`,
      description: `Sandbox call to ${path} failed: ${category}`,
      category: "",
      ref,
    });
  }
}

module.exports = (sandboxService, options) => new SandboxClient(sandboxService, options);
module.exports.SandboxClient = SandboxClient;
module.exports.SandboxError = SandboxError;
module.exports.FAILURE = FAILURE;
module.exports.SAFE_MESSAGE = SAFE_MESSAGE;
