/**
 * DigiSME /GetRawAttendance client.
 *
 * Pulls raw punch data from the DigiSME HRMS API gateway so that attendance
 * no longer depends on a manual spreadsheet upload. This is the SAME vendor
 * and the SAME gateway the removed employee sync used, but it is a different
 * integration: it reads punches only. It never writes the employee master -
 * dnds.co.in is the master (Stage 0C / C2) and nothing here changes that.
 *
 * The request shape is taken from the sync that worked in production until
 * 2026-09-07 (services/synker.js @ 7c1093f^):
 *
 *   - GET  {BASE}/Authenticate       Authorization: <apiKey>, customKey: <customKey>
 *                                    Content-Type: application/x-www-form-urlencoded
 *                                    body: Grant_type=password        -> { access_token }
 *   - GET  {BASE}/api/<Endpoint>     Authorization: bearer <token>
 *                                    body: { str: encryptAES(payload) }
 *
 * Note the vendor's manual describes a PGP step for the custom key. Our
 * account does not use it: the custom key goes in a plain header, as above.
 *
 * Credentials come from the environment. They are NOT hard-coded here - the
 * previous pair were committed as literals, are in git history, and are being
 * revoked (docs/digisme-employee-sync-removal.md). Nothing in this file may
 * repeat that.
 */

// Load .env before the constants below are captured.
//
// This module reads its credentials into `const`s AT REQUIRE TIME, and
// nothing else in it loads dotenv. Under server.js it happened to work only
// because a file under config/ - every one of which calls dotenv.config() - was
// required first: an implicit, order-dependent coupling that would leave
// API_KEY permanently `undefined` if this file were ever required earlier,
// or from a script or a test harness that loads no config. The failure mode
// is the whole integration reporting "not configured" every minute with a
// perfectly good .env sitting on disk.
//
// dotenv.config() is idempotent and never overrides a variable that is
// already set, so calling it here is safe alongside the config modules and
// alongside real environment variables set by pm2 or the shell.
require("dotenv").config();

const axios = require("axios");
const encryptAES = require("../utils/encryptAES");
const logger = require("../utils/logger");

const BASE_URL = process.env.DIGISME_BASE_URL || "https://indhrmsgateway.azurewebsites.net";
const API_KEY = process.env.DIGISME_API_KEY;
const CUSTOM_KEY = process.env.DIGISME_CUSTOM_KEY;
const COMPANY_ID = process.env.DIGISME_COMPANY_ID || "1";

/**
 * The gateway allows 5 calls per minute from a whitelisted IP.
 *
 * 15 seconds, not 13. At 13s a 60-second window can hold calls at
 * t = 0, 13, 26, 39, 52 - exactly five, sitting precisely on the vendor's
 * ceiling with no margin for clock jitter or for however their sliding
 * window rounds. At 15s the hard ceiling is four per any 60-second window,
 * which is a real margin. It costs nothing: the live sync needs one call a
 * minute, and a three-date recovery run takes 45s instead of 39s.
 */
const MIN_CALL_INTERVAL_MS = 15000;
/**
 * The interval actually used. Only `__setCallIntervalForTests` ever changes
 * it, so that the queue's spacing behaviour can be asserted in milliseconds
 * instead of costing a test run two minutes of real sleeping. It is
 * deliberately NOT an environment variable: a mistyped env var in production
 * would silently breach the vendor's limit with no error anywhere, which is
 * the whole class of failure this file exists to prevent.
 * `services/digisme_throttle.test.js` fails if any shipped file calls it.
 */
let callIntervalMs = MIN_CALL_INTERVAL_MS;
/** Tokens live 60 minutes; refresh early so a long run cannot expire mid-flight. */
const TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60000;

const COMPONENT = "SERVICE.DIGISME_ATTENDANCE";

let cachedToken = null;
let cachedTokenAt = 0;
let lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * THE ONE QUEUE every DigiSME call waits in.
 *
 * This used to read `lastCallAt`, await the gap, and only then write it
 * back. Module state is shared by every caller in the process, so that
 * looked like one throttle - but the read and the write were separated by an
 * `await`. Two concurrent callers both read the SAME `lastCallAt`, both
 * computed the SAME wait, both slept the same duration and both fired
 * simultaneously: the throttle degraded to no throttle at exactly the moment
 * two jobs overlapped. That did not matter while one nightly job existed. It
 * matters now that a per-minute live sync and a four-times-daily recovery
 * run share the process.
 *
 * The fix is to reserve the slot BEFORE awaiting, by chaining every request
 * onto a single promise. Each caller takes a numbered ticket: authentication,
 * the live fetch, the historical fetch, the 401 refresh and its retry, and
 * anything added later. No caller has to reason about the vendor's limit -
 * with a serialized queue the limit is structural, whatever is queued.
 *
 * `gate` is advanced with a swallowed rejection so that ONE FAILED CALL
 * CANNOT WEDGE THE QUEUE: the failure still reaches its own caller through
 * `mine`, but the next ticket is not poisoned by it.
 */
let gate = Promise.resolve();

function throttle() {
  const mine = gate.then(async () => {
    const wait = lastCallAt + callIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  });
  gate = mine.catch(() => {});
  return mine;
}

function assertConfigured() {
  const missing = [];
  if (!API_KEY) missing.push("DIGISME_API_KEY");
  if (!CUSTOM_KEY) missing.push("DIGISME_CUSTOM_KEY");
  if (missing.length) {
    throw new Error(
      `DigiSME attendance pull is not configured: ${missing.join(", ")} missing from the environment`
    );
  }
}

/** DD/MM/YYYY - the only format the gateway accepts for fromDate/toDate. */
function toVendorDate(value) {
  const d = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date: ${value}`);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/**
 * ClockDate + ClockTime -> a MySQL datetime string.
 *
 * The vendor returns wall-clock IST. biomax_punch.io_time is also wall-clock,
 * so the two are stored as given - no timezone conversion. (The DB session is
 * UTC; that governs NOW(), not the values we insert.)
 */
function toIoTime(clockDate, clockTime) {
  if (!clockDate || !clockTime) return null;
  const date = String(clockDate).trim().split(/[T ]/)[0];
  let ymd;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    ymd = date;
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    const [dd, mm, yyyy] = date.split("/");
    ymd = `${yyyy}-${mm}-${dd}`;
  } else {
    return null;
  }
  const t = String(clockTime).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mi = m[2];
  const ss = m[3] || "00";
  const ampm = (m[4] || "").toUpperCase();
  if (ampm === "PM" && hh < 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;
  return `${ymd} ${String(hh).padStart(2, "0")}:${mi}:${ss}`;
}

/** 'YYYY-MM-DD HH:MM:SS' -> the 14-digit 'YYYYMMDDHHMMSS' biomax_punch holds. */
function toIoTimeRaw(ioTime) {
  if (!ioTime) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(ioTime));
  return m ? `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}` : null;
}

/**
 * The vendor wraps its payload inconsistently across endpoints - sometimes a
 * bare array, sometimes { Data: [...] }, sometimes { data: { Table: [...] } }.
 * Find the first array of objects rather than assuming one shape.
 */
function extractRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of ["Data", "data", "Result", "result", "Table", "response"]) {
    const v = body[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const nested = extractRows(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

async function authenticate() {
  assertConfigured();
  await throttle();

  const response = await axios({
    method: "GET",
    url: `${BASE_URL}/Authenticate`,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: API_KEY,
      customKey: CUSTOM_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    data: "Grant_type=password",
  });

  const token =
    response.data &&
    (response.data.access_token || response.data.accesstoken || response.data.accessToken);
  if (!token) {
    throw new Error("DigiSME /Authenticate returned no access token");
  }
  return token;
}

async function getToken({ force = false } = {}) {
  if (!force && cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) {
    return cachedToken;
  }
  cachedToken = await authenticate();
  cachedTokenAt = Date.now();
  return cachedToken;
}

/**
 * Fetch raw punches for a date range.
 *
 * @param {string|Date} fromDate  inclusive
 * @param {string|Date} toDate    inclusive
 * @param {string} [empCode]      omit for all employees
 * @returns {Promise<Array>} normalised punch rows
 */
async function fetchRawAttendance(fromDate, toDate, empCode) {
  const payload = {
    CompanyId: COMPANY_ID,
    fromDate: toVendorDate(fromDate),
    toDate: toVendorDate(toDate),
  };
  if (empCode) payload.Empcode = String(empCode);

  const call = async (token) => {
    await throttle();
    return axios({
      method: "GET",
      url: `${BASE_URL}/api/GetRawAttendance`,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Authorization: `bearer ${token}` },
      data: { str: encryptAES(payload) },
    });
  };

  let response;
  try {
    response = await call(await getToken());
  } catch (error) {
    // A 401 mid-run means the token aged out; one retry on a fresh token.
    if (error.response && error.response.status === 401) {
      response = await call(await getToken({ force: true }));
    } else {
      throw error;
    }
  }

  const rows = extractRows(response.data);
  const punches = [];
  let skipped = 0;

  for (const row of rows) {
    const code = row.Code || row.code || row.EmpCode || row.Empcode;
    const ioTime = toIoTime(row.ClockDate || row.clockDate, row.ClockTime || row.clockTime);
    if (!code || !ioTime) {
      skipped += 1;
      continue;
    }
    punches.push({
      // biomax_punch.user_id is varchar(32) and holds the employee code as a
      // string. Trim only - do not renumber, do not cast.
      user_id: String(code).trim(),
      io_time: ioTime,
      // The 14-digit form a terminal sends, which is what biomax_punch
      // stores and what BOTH dedup paths key on: `import_dedup_key` is
      // CONCAT(ingest_source,'|',user_id,'|',io_time_raw), and
      // `existingImportKeys` compares io_time_raw textually. Derived here,
      // from the io_time this function already validated, so the API and the
      // Excel parser put the identical string on the identical punch.
      io_time_raw: toIoTimeRaw(ioTime),
      employee_name: row.EmployeeName || row.employeeName || null,
      clock_location: row.ClockLocation || row.clockLocation || null,
      job_location: row.JobLocation || row.jobLocation || null,
      // PunchAction and Source are NOT given a column of their own. The
      // schema's `io_mode` is a BIGINT documented as "NOT a direction flag"
      // and nothing downstream reads it - the engine pairs punches by
      // position on purpose (utils/attendance_engine.js). The whole vendor
      // row is preserved here instead, losslessly and at no schema cost,
      // so the question can be answered from data later.
      raw_json: JSON.stringify(row),
    });
  }

  logger.Log({
    level: skipped ? logger.LEVEL.WARN : logger.LEVEL.INFO,
    component: COMPONENT,
    code: `${COMPONENT}.FETCHED`,
    description: `GetRawAttendance ${payload.fromDate}-${payload.toDate}: ${punches.length} usable, ${skipped} unparseable of ${rows.length}`,
    category: "",
    ref: { fromDate: payload.fromDate, toDate: payload.toDate, skipped },
  });

  // The vendor sends every punch TWICE, byte-identical (1,050 rows for the
  // 525 real punches of 2026-09-13). Collapsing them here is a CALL-COST
  // optimisation only - it saves 525 pointless INSERT attempts a run. It is
  // NOT the correctness guarantee: that is the UNIQUE `import_dedup_key` in
  // biomax_punch, which settles a duplicate whatever this filter did.
  //
  // Keyed on io_time_raw, the same string the database keys on, so the two
  // layers can never disagree about what "the same punch" means.
  const seen = new Set();
  const deduped = punches.filter((p) => {
    if (!p.io_time_raw) return false;
    const key = `${p.user_id}|${p.io_time_raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // What the VENDOR actually sent, carried alongside the punches rather than
  // inferred from them. The caller logs this, and a caller that guessed it
  // as `deduped.length * 2` would be asserting the double-send as a law: it
  // is an observation (1,050 rows for 525 punches on 2026-09-13), and the
  // day the vendor stops doing it the log would quietly start lying. Set as
  // non-enumerable so the array still serialises and compares as an array.
  Object.defineProperty(deduped, "vendor_row_count", { value: rows.length, enumerable: false });
  Object.defineProperty(deduped, "unparseable_count", { value: skipped, enumerable: false });

  return deduped;
}


module.exports = {
  fetchRawAttendance,
  // exported for tests
  toVendorDate,
  toIoTime,
  toIoTimeRaw,
  extractRows,
  MIN_CALL_INTERVAL_MS,
  /** TEST ONLY. Returns a restore function. Never call this from shipped code. */
  __setCallIntervalForTests(ms) {
    const previous = callIntervalMs;
    callIntervalMs = ms;
    return () => {
      callIntervalMs = previous;
    };
  },
};
