require("dotenv").config();

const axios = require("axios");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const GSTAuthentication = require("./gst_authentication");

const DEFAULT_BASE_URL = "https://test-api.sandbox.co.in";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const FALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

class SandboxService {
  constructor(options = {}) {
    this.gstTaxpayerSessionRepo = options.gstTaxpayerSessionRepo || null;
    this.apiKey = options.apiKey ?? process.env.SANDBOX_API_KEY;
    this.apiSecret = options.apiSecret ?? process.env.SANDBOX_API_SECRET;
    this.baseUrl = (
      options.baseUrl ??
      process.env.SANDBOX_API_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");
    this.apiVersion =
      options.apiVersion ?? process.env.SANDBOX_API_VERSION ?? "1.0";
    /** GST compliance public APIs (e.g. GSTIN search) use a separate version header in Sandbox docs. */
    this.gstApiVersion =
      options.gstApiVersion ?? process.env.SANDBOX_GST_API_VERSION ?? "1.0.0";
    this.accessToken = null;
    /** @type {number} epoch ms — refresh when within TOKEN_REFRESH_BUFFER_MS of this */
    this.tokenExpiresAt = 0;
    this._refreshPromise = null;
    this._disabled = false;
    this.gstAuthentication = this.gstTaxpayerSessionRepo
      ? new GSTAuthentication({
          baseUrl: this.baseUrl,
          apiKey: this.apiKey,
          gstApiVersion: this.gstApiVersion,
          getSandboxAccessToken: () => this.getAccessToken(),
          sessionRepo: this.gstTaxpayerSessionRepo,
        })
      : null;
  }

  _credentialsConfigured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  isEnabled() {
    return !this._disabled && this._credentialsConfigured();
  }

  _tokenNeedsRefresh() {
    if (!this.accessToken) return true;
    return Date.now() >= this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS;
  }

  _setExpiryFromToken(token) {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded.exp === "number") {
      this.tokenExpiresAt = decoded.exp * 1000;
    } else {
      this.tokenExpiresAt = Date.now() + FALLBACK_TOKEN_TTL_MS;
    }
  }

  async _fetchNewToken() {
    const url = `${this.baseUrl}/authenticate`;
    const res = await axios.post(
      url,
      {},
      {
        headers: {
          "x-api-key": this.apiKey,
          "x-api-secret": this.apiSecret,
          "x-api-version": this.apiVersion,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    if (res.status !== 200 || !res.data || res.data.code !== 200) {
      const detail =
        res.data && typeof res.data === "object"
          ? JSON.stringify(res.data)
          : String(res.data);
      throw new Error(
        `Sandbox authenticate failed: HTTP ${res.status} ${detail}`
      );
    }

    const token = res.data.data && res.data.data.access_token;
    if (!token) {
      throw new Error("Sandbox authenticate: missing access_token in response");
    }
    this.accessToken = token;
    this._setExpiryFromToken(token);
  }

  async refreshAccessToken() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = (async () => {
      await this._fetchNewToken();
    })().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  /**
   * Obtain a token on startup when credentials are set. If unset, service stays disabled.
   */
  async initialize() {
    if (!this._credentialsConfigured()) {
      this._disabled = true;
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "SERVICE.SANDBOX",
        code: "SERVICE.SANDBOX.INIT-SKIPPED",
        description:
          "SANDBOX_API_KEY / SANDBOX_API_SECRET not set; SandboxService disabled.",
        category: "",
        ref: {},
      });
      return;
    }
    await this.refreshAccessToken();
    if (this.gstAuthentication) {
      await this.gstAuthentication.loadFromDatabase();
    }
  }

  /**
   * Raw JWT for Authorization header (do not prefix with Bearer).
   */
  async getAccessToken() {
    if (this._disabled || !this._credentialsConfigured()) {
      throw new Error(
        "SandboxService is disabled or missing SANDBOX_API_KEY / SANDBOX_API_SECRET"
      );
    }
    if (this._tokenNeedsRefresh()) {
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  async getAuthorizationHeader() {
    const token = await this.getAccessToken();
    return { Authorization: token };
  }

  /**
   * Drop cached token (e.g. Sandbox API returned 401). Next getAccessToken() fetches a new one.
   */
  invalidateAccessToken() {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * POST /gst/compliance/public/gstin/search — requires JWT (raw, no Bearer) + x-api-key.
   * @param {string} gstin
   * @param {{ acceptCache?: boolean }} [opts]
   */
  async searchGstin(gstin, opts = {}) {
    if (this._disabled || !this._credentialsConfigured()) {
      throw new Error(
        "SandboxService is disabled or missing SANDBOX_API_KEY / SANDBOX_API_SECRET"
      );
    }
    const body = { gstin: String(gstin).trim().toUpperCase() };
    const url = `${this.baseUrl}/gst/compliance/public/gstin/search`;

    const request = async () => {
      const token = await this.getAccessToken();
      const headers = {
        Authorization: token,
        "x-api-key": this.apiKey,
        "x-api-version": this.gstApiVersion,
      };
      if (opts.acceptCache === true) {
        headers["x-accept-cache"] = "true";
      }
      return axios.post(url, body, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });
    };

    let res = await request();
    if (res.status === 401) {
      this.invalidateAccessToken();
      res = await request();
    }
    return res;
  }

  /**
   * GET /gst/compliance/tax-payer/gstrs/gstr-2a/b2b/{year}/{month}
   * Requires GST taxpayer session (JWT in Authorization, raw — no Bearer).
   * @see https://developer.sandbox.co.in/api-reference/gst/compliance/endpoints/taxpayer/gstr-2a/b2b
   * @param {string} year e.g. "2024"
   * @param {string} month e.g. "04" or "4"
   * @param {{ counterparty_gstin?: string, from?: string }} [query]
   */
  async getGstr2aB2b(year, month, query = {}) {
    if (this._disabled || !this._credentialsConfigured()) {
      throw new Error(
        "SandboxService is disabled or missing SANDBOX_API_KEY / SANDBOX_API_SECRET"
      );
    }
    if (!this.gstAuthentication) {
      throw new Error(
        "GST taxpayer authentication is not configured on this server"
      );
    }

    const y = String(year).trim();
    const m = String(month).trim().padStart(2, "0");
    const url = `${this.baseUrl}/gst/compliance/tax-payer/gstrs/gstr-2a/b2b/${encodeURIComponent(y)}/${encodeURIComponent(m)}`;

    const token = await this.gstAuthentication.getTaxpayerAccessTokenForGstApis();

    const params = {};
    if (query.counterparty_gstin) {
      params.counterparty_gstin = String(query.counterparty_gstin)
        .trim()
        .toUpperCase();
    }
    if (query.from) {
      params.from = String(query.from).trim();
    }

    const headers = {
      accept: "application/json",
      Authorization: token,
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "x-api-version": this.gstApiVersion,
    };

    return axios.get(url, {
      headers,
      params,
      timeout: 120000,
      validateStatus: () => true,
    });
  }
}

module.exports = SandboxService;
