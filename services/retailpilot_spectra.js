const axios = require("axios");

/**
 * Client for RetailPilot's SPECTRA query API.
 *
 * POST <baseUrl>/spectra/query with { query, page, size } runs a read-only
 * SELECT and returns { meta: { columns }, data: [rows], pagination:
 * { total, has_next } }, or { error, detail } on failure.
 */
class RetailPilotSpectra {
  constructor(config, http = axios) {
    this.config = config;
    this.http = http;
  }

  isConfigured() {
    return Boolean(this.config.baseUrl && this.config.apiKey);
  }

  async _page(query, page) {
    const { baseUrl, apiKey, product, pageSize, timeoutMs } = this.config;
    let response;
    try {
      response = await this.http({
        method: "POST",
        url: `${baseUrl}/spectra/query`,
        data: { query, page, size: pageSize },
        headers: {
          "X-Authentication": apiKey,
          "X-Product": product,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      const status = err.response && err.response.status;
      const body = err.response && err.response.data;
      const detail = body ? JSON.stringify(body).slice(0, 500) : err.message;
      throw new Error(`SPECTRA request failed${status ? ` (HTTP ${status})` : ""}: ${detail}`);
    }
    const data = response.data || {};
    if (data.error) {
      throw new Error(`SPECTRA error: ${data.error}${data.detail ? ` - ${data.detail}` : ""}`);
    }
    if (!Array.isArray(data.data) || !data.pagination) {
      throw new Error("SPECTRA returned an unexpected response shape");
    }
    return data;
  }

  /** Every row of `query`, across all pages. */
  async queryAll(query, maxPages = 500) {
    if (!this.isConfigured()) {
      throw new Error("RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)");
    }
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this._page(query, page);
      rows.push(...data.data);
      if (!data.pagination.has_next) return rows;
    }
    throw new Error(`SPECTRA query did not finish within ${maxPages} pages`);
  }
}

module.exports = (config, http) => new RetailPilotSpectra(config, http);
