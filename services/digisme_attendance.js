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



const axios = require("axios");

const encryptAES = require("../utils/encryptAES");

const logger = require("../utils/logger");



const BASE_URL = process.env.DIGISME_BASE_URL || "https://indhrmsgateway.azurewebsites.net";

const API_KEY = process.env.DIGISME_API_KEY;

const CUSTOM_KEY = process.env.DIGISME_CUSTOM_KEY;

const COMPANY_ID = process.env.DIGISME_COMPANY_ID || "1";



/** The gateway allows 5 calls per minute from a whitelisted IP. */

const MIN_CALL_INTERVAL_MS = 13000;

/** Tokens live 60 minutes; refresh early so a long run cannot expire mid-flight. */

const TOKEN_TTL_MS = 50 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 60000;



const COMPONENT = "SERVICE.DIGISME_ATTENDANCE";



let cachedToken = null;

let cachedTokenAt = 0;

let lastCallAt = 0;



const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



/** Space calls out so we stay under the vendor's 5/minute limit. */

async function throttle() {

  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();

  if (wait > 0) await sleep(wait);

  lastCallAt = Date.now();

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

      employee_name: row.EmployeeName || row.employeeName || null,

      clock_location: row.ClockLocation || row.clockLocation || null,

      job_location: row.JobLocation || row.jobLocation || null,

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



  const seen = new Set();

  const deduped = punches.filter((p) => {

    const key = `${p.user_id}|${p.io_time}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;

  });



  return deduped;
}



module.exports = {

  fetchRawAttendance,

  // exported for tests

  toVendorDate,

  toIoTime,

  extractRows,

};
