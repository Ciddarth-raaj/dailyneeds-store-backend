const axios = require("axios");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");

/**
 * HARDCODED GST portal credentials for Sandbox taxpayer OTP + session APIs.
 * Replace with the GST portal username (typically email) and 15-char GSTIN.
 * @see https://developer.sandbox.co.in/recipes/gst/authentication/generate_tax_payer_session
 */
const SANDBOX_GST_TAXPAYER_USERNAME = "DAILY567";
const SANDBOX_GST_TAXPAYER_GSTIN = "34AAJFD4987C1ZD";

const MS_DAY = 24 * 60 * 60 * 1000;
/** GST portal session: OTP must be repeated after this window (29 days from last verify). */
const REVALIDATION_REQUIRED_AFTER_MS = 29 * MS_DAY;
/** GST portal session wall: new OTP required after this from last verify. */
const SESSION_MAX_MS = 30 * MS_DAY;

const RENEWAL_LEAD_MS = 15 * 60 * 1000;

const REQUIRES_OTP_CODE = 428;

class GSTAuthentication {
  /**
   * @param {{
   *   baseUrl: string,
   *   apiKey: string,
   *   gstApiVersion: string,
   *   getSandboxAccessToken: () => Promise<string>,
   *   sessionRepo: object
   * }} deps
   */
  constructor(deps) {
    this.baseUrl = deps.baseUrl.replace(/\/$/, "");
    this.apiKey = deps.apiKey;
    this.gstApiVersion = deps.gstApiVersion;
    this.getSandboxAccessToken = deps.getSandboxAccessToken;
    this.sessionRepo = deps.sessionRepo;
    this._taxpayerToken = null;
    this._taxpayerTokenExpiresAtMs = null;
    this._lastOtpVerifiedAtMs = null;
    this._sessionExpiresAtMs = null;
    this._refreshPromise = null;
  }

  getHardcodedUsername() {
    return SANDBOX_GST_TAXPAYER_USERNAME;
  }

  getHardcodedGstin() {
    return SANDBOX_GST_TAXPAYER_GSTIN;
  }

  _otpHeaders(sandboxJwt) {
    return {
      accept: "application/json",
      Authorization: sandboxJwt,
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "x-api-version": this.gstApiVersion,
      "x-source": "primary",
    };
  }

  _refreshHeaders(taxpayerJwt) {
    return {
      accept: "application/json",
      Authorization: taxpayerJwt,
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "x-api-version": this.gstApiVersion,
    };
  }

  _parseTokenSessionFromApiBody(body) {
    if (!body || body.code !== 200 || !body.data) {
      return null;
    }
    let d = body.data;
    if (d && typeof d.data === "object" && d.data !== null && !d.access_token) {
      d = { ...d, ...d.data };
    }
    const token =
      d.access_token ||
      d.token ||
      (d.data && (d.data.access_token || d.data.token));
    if (!token || typeof token !== "string") {
      return null;
    }
    let tokenExpMs = null;
    const tokenCandidates = [
      d.token_expiry,
      d.expiry,
      d.data && d.data.token_expiry,
    ];
    for (const c of tokenCandidates) {
      if (c == null) continue;
      const n = Number(c);
      if (!Number.isFinite(n)) continue;
      tokenExpMs = n < 1e12 ? n * 1000 : n;
      break;
    }
    if (tokenExpMs == null) {
      const decoded = jwt.decode(token);
      if (decoded && typeof decoded.exp === "number") {
        tokenExpMs = decoded.exp * 1000;
      }
    }
    let sessionExpMs = null;
    const sessionCandidates = [
      d.session_expiry,
      d.data && d.data.session_expiry,
    ];
    for (const c of sessionCandidates) {
      if (c == null) continue;
      const n = Number(c);
      if (!Number.isFinite(n)) continue;
      sessionExpMs = n < 1e12 ? n * 1000 : n;
      break;
    }
    return { token, tokenExpMs, sessionExpMs };
  }

  async loadFromDatabase() {
    const row = await this.sessionRepo.getSingleton();
    this._taxpayerToken = row.taxpayer_access_token || null;
    this._taxpayerTokenExpiresAtMs =
      row.token_expires_at_ms != null ? Number(row.token_expires_at_ms) : null;
    this._lastOtpVerifiedAtMs =
      row.last_otp_verified_at_ms != null
        ? Number(row.last_otp_verified_at_ms)
        : null;
    this._sessionExpiresAtMs =
      row.session_expires_at_ms != null
        ? Number(row.session_expires_at_ms)
        : null;
  }

  requiresGstTaxpayerRevalidation() {
    if (this._lastOtpVerifiedAtMs == null) {
      return false;
    }
    const now = Date.now();
    if (this._sessionExpiresAtMs != null && now >= this._sessionExpiresAtMs) {
      return false;
    }
    return now >= this._lastOtpVerifiedAtMs + REVALIDATION_REQUIRED_AFTER_MS;
  }

  isSessionWallExpired() {
    if (this._sessionExpiresAtMs == null) {
      return false;
    }
    return Date.now() >= this._sessionExpiresAtMs;
  }

  getTaxpayerSessionStatusPayload() {
    const last = this._lastOtpVerifiedAtMs;
    const revalidationAfter =
      last != null ? last + REVALIDATION_REQUIRED_AFTER_MS : null;
    const sessionExpired = this.isSessionWallExpired();
    const needsRevalidation =
      !sessionExpired && this.requiresGstTaxpayerRevalidation();
    return {
      has_taxpayer_token: Boolean(this._taxpayerToken),
      token_expires_at_ms: this._taxpayerTokenExpiresAtMs,
      session_expires_at_ms: this._sessionExpiresAtMs,
      last_otp_verified_at_ms: last,
      revalidation_required_after_ms: revalidationAfter,
      needs_revalidation: needsRevalidation,
      session_expired: sessionExpired,
    };
  }

  buildRequiresOtpError(extra = {}) {
    const s = this.getTaxpayerSessionStatusPayload();
    return {
      code: REQUIRES_OTP_CODE,
      requires_gst_taxpayer_otp: true,
      msg:
        extra.msg ||
        "GST taxpayer OTP is required before calling this API. Complete request OTP + verify (or revalidate) flow.",
      token_expires_at_ms: s.token_expires_at_ms,
      session_expires_at_ms: s.session_expires_at_ms,
      last_otp_verified_at_ms: s.last_otp_verified_at_ms,
      revalidation_required_after_ms: s.revalidation_required_after_ms,
      needs_revalidation: s.needs_revalidation,
      session_expired: s.session_expired,
      ...extra,
    };
  }

  /**
   * @returns {Promise<null | object>} null if taxpayer JWT can be used for GST taxpayer APIs.
   */
  async ensureTaxpayerTokenUsableForGstApis() {
    await this.loadFromDatabase();
    const now = Date.now();

    if (this.isSessionWallExpired()) {
      if (this._taxpayerToken || this._lastOtpVerifiedAtMs) {
        await this._clearFullSession();
      }
      return this.buildRequiresOtpError({
        session_expired: true,
        msg: "GST taxpayer session (30 days) has expired. Run request OTP + verify to start a new session.",
      });
    }

    if (this.requiresGstTaxpayerRevalidation()) {
      return this.buildRequiresOtpError({
        needs_revalidation: true,
        msg: "GST taxpayer session requires OTP revalidation (day 29 or later in the 30-day window). Run request OTP + verify or the revalidate endpoint.",
      });
    }

    if (!this._taxpayerToken) {
      return this.buildRequiresOtpError({
        needs_initial_otp: true,
        msg: "No GST taxpayer session. Run request OTP + verify before calling taxpayer-authenticated GST APIs.",
      });
    }

    if (
      this._taxpayerTokenExpiresAtMs != null &&
      now >= this._taxpayerTokenExpiresAtMs
    ) {
      try {
        await this.refreshTaxpayerSession();
        await this.loadFromDatabase();
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.GST_AUTHENTICATION",
          code: "SERVICE.GST_AUTHENTICATION.ENSURE-REFRESH",
          description: err.toString(),
          category: "",
          ref: {},
        });
      }
      if (
        !this._taxpayerToken ||
        (this._taxpayerTokenExpiresAtMs != null &&
          Date.now() >= this._taxpayerTokenExpiresAtMs)
      ) {
        return this.buildRequiresOtpError({
          msg: "GST taxpayer access token expired and could not be refreshed.",
        });
      }
    }

    return null;
  }

  async getTaxpayerAccessTokenForGstApis() {
    const err = await this.ensureTaxpayerTokenUsableForGstApis();
    if (err) {
      const e = new Error(err.msg || "GST taxpayer OTP required");
      e.gstOtpPayload = err;
      throw e;
    }
    return this._taxpayerToken;
  }

  async _persistAfterOtp(parsed) {
    const now = Date.now();
    const token = parsed.token;
    const tokenExpMs =
      parsed.tokenExpMs ||
      (() => {
        const dec = jwt.decode(token);
        return dec && dec.exp ? dec.exp * 1000 : now + 6 * 60 * 60 * 1000;
      })();
    const sessionExpMs =
      parsed.sessionExpMs && parsed.sessionExpMs > now
        ? parsed.sessionExpMs
        : now + SESSION_MAX_MS;

    this._taxpayerToken = token;
    this._taxpayerTokenExpiresAtMs = tokenExpMs;
    this._lastOtpVerifiedAtMs = now;
    this._sessionExpiresAtMs = sessionExpMs;

    await this.sessionRepo.updateAfterOtpVerify({
      taxpayerAccessToken: token,
      tokenExpiresAtMs: tokenExpMs,
      lastOtpVerifiedAtMs: now,
      sessionExpiresAtMs: sessionExpMs,
    });
  }

  async _persistAfterRefresh(parsed) {
    const token = parsed.token;
    const tokenExpMs =
      parsed.tokenExpMs ||
      (() => {
        const dec = jwt.decode(token);
        return dec && dec.exp
          ? dec.exp * 1000
          : Date.now() + 6 * 60 * 60 * 1000;
      })();

    this._taxpayerToken = token;
    this._taxpayerTokenExpiresAtMs = tokenExpMs;
    await this.sessionRepo.updateAfterTokenRefresh(token, tokenExpMs);
  }

  async _clearFullSession() {
    this._taxpayerToken = null;
    this._taxpayerTokenExpiresAtMs = null;
    this._lastOtpVerifiedAtMs = null;
    this._sessionExpiresAtMs = null;
    await this.sessionRepo.clearFullSession();
  }

  async _clearJwtOnly() {
    this._taxpayerToken = null;
    this._taxpayerTokenExpiresAtMs = null;
    await this.sessionRepo.clearTaxpayerJwtOnly();
  }

  /**
   * After 29 days from last OTP, drop stored JWT so automation stops until re-verify.
   */
  async applyDay29RevalidationJwtClear() {
    await this.loadFromDatabase();
    if (!this._lastOtpVerifiedAtMs) {
      return { did: false, reason: "no_otp_anchor" };
    }
    const now = Date.now();
    if (now < this._lastOtpVerifiedAtMs + REVALIDATION_REQUIRED_AFTER_MS) {
      return { did: false, reason: "before_day_29" };
    }
    if (this._sessionExpiresAtMs != null && now >= this._sessionExpiresAtMs) {
      return { did: false, reason: "session_wall_passed" };
    }
    if (!this._taxpayerToken) {
      return { did: false, reason: "already_no_jwt" };
    }
    await this._clearJwtOnly();
    await this.loadFromDatabase();
    logger.Log({
      level: logger.LEVEL.INFO,
      component: "SERVICE.GST_AUTHENTICATION",
      code: "SERVICE.GST_AUTHENTICATION.DAY29-JWT-CLEARED",
      description:
        "Cleared stored GST taxpayer JWT on day-29 revalidation window (OTP required for taxpayer APIs).",
      category: "",
      ref: {},
    });
    return { did: true };
  }

  /** Remove DB row timing if 30-day wall passed. */
  async applySessionWallExpiryCleanup() {
    await this.loadFromDatabase();
    if (!this.isSessionWallExpired()) {
      return { did: false };
    }
    await this._clearFullSession();
    logger.Log({
      level: logger.LEVEL.INFO,
      component: "SERVICE.GST_AUTHENTICATION",
      code: "SERVICE.GST_AUTHENTICATION.SESSION-WALL-CLEARED",
      description: "Cleared GST taxpayer session after 30-day session expiry.",
      category: "",
      ref: {},
    });
    return { did: true };
  }

  async requestTaxpayerOtp() {
    const sandboxJwt = await this.getSandboxAccessToken();
    const url = `${this.baseUrl}/gst/compliance/tax-payer/otp`;
    const res = await axios.post(
      url,
      {
        username: SANDBOX_GST_TAXPAYER_USERNAME,
        gstin: SANDBOX_GST_TAXPAYER_GSTIN,
      },
      {
        headers: this._otpHeaders(sandboxJwt),
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    return res;
  }

  async verifyTaxpayerOtp(otp) {
    const sandboxJwt = await this.getSandboxAccessToken();
    const q = encodeURIComponent(String(otp).trim());
    const url = `${this.baseUrl}/gst/compliance/tax-payer/otp/verify?otp=${q}`;
    const res = await axios.post(
      url,
      {
        username: SANDBOX_GST_TAXPAYER_USERNAME,
        gstin: SANDBOX_GST_TAXPAYER_GSTIN,
      },
      {
        headers: this._otpHeaders(sandboxJwt),
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    if (res.status === 200 && res.data && res.data.code === 200) {
      const parsed = this._parseTokenSessionFromApiBody(res.data);
      if (parsed && parsed.token) {
        await this._persistAfterOtp(parsed);
      } else {
        logger.Log({
          level: logger.LEVEL.WARN,
          component: "SERVICE.GST_AUTHENTICATION",
          code: "SERVICE.GST_AUTHENTICATION.VERIFY-PARSE",
          description:
            "Verify OTP returned code 200 but taxpayer token not parsed; session not saved",
          category: "",
          ref: {},
        });
      }
    }

    return res;
  }

  async refreshTaxpayerSession() {
    if (this.requiresGstTaxpayerRevalidation() || this.isSessionWallExpired()) {
      throw new Error(
        "GST taxpayer refresh blocked: OTP revalidation or new session required"
      );
    }

    if (!this._taxpayerToken) {
      await this.loadFromDatabase();
    }
    if (!this._taxpayerToken) {
      throw new Error(
        "GST taxpayer session missing; complete OTP verify flow first"
      );
    }

    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = (async () => {
      const url = `${this.baseUrl}/gst/compliance/tax-payer/session/refresh`;
      const res = await axios.post(
        url,
        {},
        {
          headers: this._refreshHeaders(this._taxpayerToken),
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      if (res.status === 401 || res.status === 403) {
        await this._clearFullSession();
        logger.Log({
          level: logger.LEVEL.WARN,
          component: "SERVICE.GST_AUTHENTICATION",
          code: "SERVICE.GST_AUTHENTICATION.REFRESH-UNAUTHORIZED",
          description: `Taxpayer session refresh failed HTTP ${res.status}; OTP flow required again`,
          category: "",
          ref: {},
        });
        return res;
      }

      if (res.status === 200 && res.data && res.data.code === 200) {
        const parsed = this._parseTokenSessionFromApiBody(res.data);
        if (parsed && parsed.token) {
          await this._persistAfterRefresh(parsed);
        } else {
          logger.Log({
            level: logger.LEVEL.WARN,
            component: "SERVICE.GST_AUTHENTICATION",
            code: "SERVICE.GST_AUTHENTICATION.REFRESH-PARSE",
            description:
              "Taxpayer session refresh HTTP 200 but token not parsed; keeping previous session if any",
            category: "",
            ref: {},
          });
        }
      }

      return res;
    })().finally(() => {
      this._refreshPromise = null;
    });

    return this._refreshPromise;
  }

  async refreshIfWithinRenewalWindow() {
    await this.loadFromDatabase();

    if (this.isSessionWallExpired()) {
      await this._clearFullSession();
      return { skipped: true, reason: "session_wall_expired" };
    }

    if (this.requiresGstTaxpayerRevalidation()) {
      return { skipped: true, reason: "revalidation_required" };
    }

    const now = Date.now();
    const exp = this._taxpayerTokenExpiresAtMs;
    const token = this._taxpayerToken;

    if (!token || exp == null) {
      return { skipped: true, reason: "no_session" };
    }

    if (now >= exp) {
      await this._clearJwtOnly();
      await this.loadFromDatabase();
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "SERVICE.GST_AUTHENTICATION",
        code: "SERVICE.GST_AUTHENTICATION.TOKEN-EXPIRED-CLEARED",
        description:
          "GST taxpayer access token expired before refresh; cleared JWT — run OTP verify if still within 30-day session window",
        category: "",
        ref: {},
      });
      return { skipped: true, reason: "token_expired_cleared" };
    }

    if (now < exp - RENEWAL_LEAD_MS) {
      return { skipped: true, reason: "too_early" };
    }

    await this.refreshTaxpayerSession();
    return { skipped: false, refreshed: true };
  }

  getTaxpayerAccessTokenFromMemory() {
    return this._taxpayerToken;
  }

  getTaxpayerTokenExpiresAtMs() {
    return this._taxpayerTokenExpiresAtMs;
  }
}

module.exports = GSTAuthentication;
module.exports.SANDBOX_GST_TAXPAYER_USERNAME = SANDBOX_GST_TAXPAYER_USERNAME;
module.exports.SANDBOX_GST_TAXPAYER_GSTIN = SANDBOX_GST_TAXPAYER_GSTIN;
module.exports.RENEWAL_LEAD_MS = RENEWAL_LEAD_MS;
module.exports.REVALIDATION_REQUIRED_AFTER_MS = REVALIDATION_REQUIRED_AFTER_MS;
module.exports.SESSION_MAX_MS = SESSION_MAX_MS;
module.exports.REQUIRES_OTP_CODE = REQUIRES_OTP_CODE;
