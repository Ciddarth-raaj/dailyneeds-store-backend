const axios = require("axios");

/**
 * Client for RetailPilot's SPECTRA query API.
 *
 * POST <baseUrl>/spectra/query with { query, page, size } runs a read-only
 * SELECT and returns { meta: { columns }, data: [rows], pagination:
 * { total, has_next } }, or { error, detail } on failure.
 *
 * Retries are OPT-IN (config.retry), so the syncs that predate them behave
 * exactly as before: one attempt, the same error messages. With config.retry:
 *   - HTTP 429 waits Retry-After seconds and retries; a Retry-After above
 *     maxRetryAfterSec is NOT shortened: the error is thrown with
 *     .deferred = true and .retryAfterSec, so the caller defers the run
 *   - HTTP 5xx, timeouts and connection errors retry with backoffMs
 *   - HTTP 4xx other than 429 (parse_error, validation_error,
 *     whitelist_violation, auth) is never retried: the query itself is wrong
 * Errors carry .status (HTTP status, 0 = no response), .spectraError (the
 * body's `error` code) and .retryable, and never the key or headers.
 */
const DEFAULT_RETRY = { attempts: 4, backoffMs: [2000, 8000, 30000], maxRetryAfterSec: 120 };

class RetailPilotSpectra {
  constructor(config, http = axios, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.config = config;
    this.http = http;
    this.sleep = sleep;
  }

  _retryPolicy() {
    const r = this.config.retry;
    if (!r) return null;
    return { ...DEFAULT_RETRY, ...(typeof r === "object" ? r : {}) };
  }

  /** One page, retried per the opt-in policy. */
  async _pageWithRetry(query, page, size) {
    const policy = this._retryPolicy();
    if (!policy) return this._page(query, page, size);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this._page(query, page, size);
      } catch (err) {
        if (!err.retryable || attempt >= policy.attempts) throw err;
        let waitMs;
        if (err.status === 429) {
          const sec = Number(err.retryAfter);
          const wait = Number.isFinite(sec) && sec >= 0 ? sec : 30;
          // RetailPilot asked for longer than we may wait: never retry early.
          // The caller defers the run (watermarks untouched) until then.
          if (wait > policy.maxRetryAfterSec) {
            err.deferred = true;
            err.retryAfterSec = wait;
            err.retryable = false;
            throw err;
          }
          waitMs = wait * 1000;
        } else {
          const b = policy.backoffMs;
          waitMs = b[Math.min(attempt - 1, b.length - 1)];
        }
        await this.sleep(waitMs);
      }
    }
  }

  isConfigured() {
    return Boolean(this.config.baseUrl && this.config.apiKey);
  }

  async _page(query, page, size) {
    const { baseUrl, apiKey, product, pageSize, timeoutMs } = this.config;
    let response;
    try {
      response = await this.http({
        method: "POST",
        url: `${baseUrl}/spectra/query`,
        data: { query, page, size: size || pageSize },
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
      // Long enough for a whitelist_violation's full list of allowed tables.
      const detail = body ? JSON.stringify(body).slice(0, 4000) : err.message;
      const e = new Error(`SPECTRA request failed${status ? ` (HTTP ${status})` : ""}: ${detail}`);
      e.status = status || 0;
      e.spectraError = body && typeof body === "object" ? body.error || null : null;
      e.retryAfter = err.response && err.response.headers ? err.response.headers["retry-after"] : undefined;
      e.retryable = !status || status === 429 || status >= 500;
      throw e;
    }
    const data = response.data || {};
    if (data.error) {
      const e = new Error(`SPECTRA error: ${data.error}${data.detail ? ` - ${data.detail}` : ""}`);
      e.status = response.status || 200;
      e.spectraError = data.error;
      e.retryable = false;
      throw e;
    }
    if (!Array.isArray(data.data) || !data.pagination) {
      throw new Error("SPECTRA returned an unexpected response shape");
    }
    return data;
  }

  /**
   * Run `query` page by page, handing each page's rows to onPage before the
   * next is fetched, so a table of hundreds of thousands of rows never sits
   * in memory at once. Resolves to the number of rows read.
   */
  async queryEach(query, onPage, maxPages = 2000) {
    if (!this.isConfigured()) {
      throw new Error("RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)");
    }
    let total = 0;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this._pageWithRetry(query, page);
      total += data.data.length;
      await onPage(data.data);
      if (!data.pagination.has_next) return total;
    }
    throw new Error(`SPECTRA query did not finish within ${maxPages} pages`);
  }

  /** Every row of `query`, across all pages. */
  async queryAll(query, maxPages = 500) {
    if (!this.isConfigured()) {
      throw new Error("RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)");
    }
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this._pageWithRetry(query, page);
      rows.push(...data.data);
      if (!data.pagination.has_next) return rows;
    }
    throw new Error(`SPECTRA query did not finish within ${maxPages} pages`);
  }

  /**
   * Keyset paging for watermark syncs. Page numbers shift when a row is
   * updated mid-run (it moves to the end of an updated_at order), so each
   * request is page 1 of a query that starts AFTER the last row read.
   *
   * @param buildQuery (cursor) => SQL ordered by the cursor columns, LIMIT = size
   * @param cursor     the starting cursor (e.g. { ts, slug }) or null
   * @param cursorOf   (row) => the cursor that row ends at
   * @param onPage     async (rows, cursorAfterPage) => void, before the next read
   * @returns { rows, pages, cursor } - cursor = after the last row read
   */
  async queryKeyset(buildQuery, cursor, cursorOf, onPage, { size, maxPages = 1000 } = {}) {
    if (!this.isConfigured()) {
      throw new Error("RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)");
    }
    const pageSize = Math.min(size || this.config.pageSize || 2000, 2000);
    let rows = 0;
    for (let pages = 1; pages <= maxPages; pages++) {
      const data = await this._pageWithRetry(buildQuery(cursor, pageSize), 1, pageSize);
      const batch = data.data;
      if (batch.length) {
        const next = cursorOf(batch[batch.length - 1]);
        if (JSON.stringify(next) === JSON.stringify(cursor)) {
          throw new Error("SPECTRA keyset paging did not advance: the query must order by and filter after the cursor");
        }
        cursor = next;
      }
      rows += batch.length;
      await onPage(batch, cursor);
      if (batch.length < pageSize) return { rows, pages, cursor };
    }
    throw new Error(`SPECTRA keyset query did not finish within ${maxPages} pages`);
  }
}

module.exports = (config, http, sleep) => new RetailPilotSpectra(config, http, sleep);
module.exports.DEFAULT_RETRY = DEFAULT_RETRY;
