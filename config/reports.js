require("dotenv").config();

/**
 * Reports — limits.
 *
 * These exist to protect a single Lightsail box from one careless export.
 * They are configuration rather than constants so a limit can be raised
 * without a deploy, but every one has a working default: a missing or
 * nonsense environment value falls back rather than disabling the limit,
 * because an unset cap is the failure these are meant to prevent.
 */

const positiveInt = (raw, fallback) => {
  const n = Number(String(raw ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

module.exports = {
  /** How many columns one report may select. */
  MAX_FIELDS: positiveInt(process.env.EMPLOYEE_REPORT_MAX_FIELDS, 30),

  /**
   * The hard row cap for an export. 630 employees today, so 5,000 is ample
   * headroom while still refusing anything that could only be a mistake or a
   * loop.
   */
  MAX_ROWS: positiveInt(process.env.EMPLOYEE_REPORT_MAX_ROWS, 5000),

  /** Preview page size, and its ceiling. */
  DEFAULT_PAGE_SIZE: positiveInt(process.env.EMPLOYEE_REPORT_PAGE_SIZE, 25),
  MAX_PAGE_SIZE: positiveInt(process.env.EMPLOYEE_REPORT_MAX_PAGE_SIZE, 100),

  /**
   * How long one export may run before it is abandoned. A streamed export
   * holds a database cursor; without a deadline a stuck client holds it open.
   */
  EXPORT_TIMEOUT_MS: positiveInt(process.env.EMPLOYEE_REPORT_TIMEOUT_MS, 60000),

  /** Rows fetched per chunk while streaming, to bound memory. */
  STREAM_CHUNK: positiveInt(process.env.EMPLOYEE_REPORT_STREAM_CHUNK, 500),
};
