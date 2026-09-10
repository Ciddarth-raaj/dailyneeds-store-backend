/**
 * Biomax BM70W wire protocol - pure functions, no I/O.
 *
 * Everything here was captured off real hardware on 2026-09-10 and is kept
 * byte-exact in test_support/biomax/. The vendor's 2019 SDK describes a
 * different protocol that this firmware does not speak; ignore it.
 *
 * Request: `POST /hdata.aspx HTTP/1.0` with custom headers. The ONLY header
 * that decides what a request is:
 *
 *   request_code: realtime_glog   an attendance punch (body below)
 *   request_code: receive_cmd     "any commands for me?" (~every 20 s)
 *
 * Punch body: <uint32 LE length><JSON><0x0A><0x00>, where the length covers
 * everything after the four bytes and `4 + length == Content-Length`.
 *
 *   {"fk_bin_data_lib":"FKDataHS102","io_mode":16777216,
 *    "io_time":"20260910135741","log_image":null,
 *    "user_id":"1952","verify_mode":1073741824}
 *
 * Reply: the device IGNORES the HTTP status line and reads a custom
 * `response_code` header. A bare 200 with no such header is not a soft
 * failure - the device retries several times a second. The exact header
 * blocks DigiSME sends, and that the devices are known to accept, are
 * test_support/biomax/digisme-reply-ok.bin and
 * digisme-reply-error-no-cmd.bin; `buildAckHeaders` reproduces the headers
 * that matter from them, in the same order.
 */

const REQUEST_PUNCH = "realtime_glog";
const REQUEST_POLL = "receive_cmd";

const ACK_OK = "OK";
const ACK_NO_CMD = "ERROR_NO_CMD";

/** The 14-digit device timestamp, device-local IST. */
const IO_TIME_RE = /^\d{14}$/;

/** Longest body we will read. A real punch is 144 bytes. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Node's `req.headers` is already lower-cased; a raw header map from a
 * `net`-level parser may not be. Accept either.
 */
function headerValue(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      // Node folds a repeated header into an array for some names; the
      // device repeats Content-Type, which Node keeps as the first value,
      // but be safe for any header.
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * What kind of request this is (R10). Anything that is not a punch is
 * answered as a poll, and flagged `unknown` when the code is not the poll
 * code either, so an unrecognised command channel never blocks a device and
 * is still visible for diagnosis.
 */
function classifyRequest(headers) {
  const raw = headerValue(headers, "request_code");
  const code = raw === undefined || raw === null ? "" : String(raw).trim();
  if (code === REQUEST_PUNCH) return { kind: "punch", code, unknown: false };
  if (code === REQUEST_POLL) return { kind: "poll", code, unknown: false };
  return { kind: "poll", code, unknown: true };
}

/** The identifying headers every request carries, trimmed, as strings. */
function readEnvelope(headers) {
  const str = (name) => {
    const v = headerValue(headers, name);
    return v === undefined || v === null ? null : String(v).trim();
  };
  const int = (name) => {
    const v = str(name);
    if (v === null || v === "" || !/^\d+$/.test(v)) return null;
    return Number(v);
  };
  return {
    dev_id: str("dev_id"),
    cmd_id: str("cmd_id"),
    blk_no: int("blk_no"),
    blk_len: int("blk_len"),
    content_length: int("content-length"),
  };
}

/**
 * Parse a punch body.
 *
 * Lenient on framing, strict on content: the JSON is located between the
 * first `{` and the last `}` rather than trusting the length prefix (which
 * is still read and compared, with a warning when it disagrees), but the
 * fields we store must be what they claim to be. `user_id` is coerced to a
 * string if the device ever sends a number (it is a code, not a quantity)
 * and is otherwise stored verbatim - no trimming, no zero-stripping (R5).
 *
 * @returns {{ok: true, punch: object, warnings: string[]} |
 *           {ok: false, reason: string}}
 */
function parsePunchBody(buffer) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, reason: "body is not a buffer" };
  if (buffer.length === 0) return { ok: false, reason: "empty body" };

  const warnings = [];
  let prefix = null;
  if (buffer.length >= 4) {
    prefix = buffer.readUInt32LE(0);
    if (prefix !== buffer.length - 4) {
      warnings.push(`length prefix ${prefix} disagrees with body length ${buffer.length - 4}`);
    }
  } else {
    warnings.push("body shorter than the 4-byte length prefix");
  }

  const start = buffer.indexOf(0x7b); // {
  const end = buffer.lastIndexOf(0x7d); // }
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, reason: "no JSON object in body" };
  }
  const rawJson = buffer.subarray(start, end + 1).toString("utf8");

  let json;
  try {
    json = JSON.parse(rawJson);
  } catch (err) {
    return { ok: false, reason: `JSON parse failed: ${err.message}` };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "JSON body is not an object" };
  }

  // user_id: string verbatim; number -> its decimal string; anything else
  // is a malformed punch.
  let userId;
  if (typeof json.user_id === "string") {
    userId = json.user_id;
  } else if (typeof json.user_id === "number" && Number.isInteger(json.user_id)) {
    userId = String(json.user_id);
    warnings.push("user_id arrived as a JSON number");
  } else {
    return { ok: false, reason: "user_id missing or not a string" };
  }
  if (userId.length === 0 || userId.length > 32) {
    return { ok: false, reason: `user_id length ${userId.length} out of range` };
  }

  const ioTime = typeof json.io_time === "string" ? json.io_time : null;
  if (ioTime === null || !IO_TIME_RE.test(ioTime) || !isRealTimestamp(ioTime)) {
    return { ok: false, reason: `io_time missing or not a valid YYYYMMDDHHMMSS: ${JSON.stringify(json.io_time)}` };
  }

  const bigintOrNull = (v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

  return {
    ok: true,
    warnings,
    punch: {
      user_id: userId,
      io_time_raw: ioTime,
      verify_mode: bigintOrNull(json.verify_mode),
      io_mode: bigintOrNull(json.io_mode),
      fk_bin_data_lib:
        typeof json.fk_bin_data_lib === "string" ? json.fk_bin_data_lib.slice(0, 40) : null,
      log_image_present: json.log_image !== null && json.log_image !== undefined ? 1 : 0,
      body_len_prefix: prefix,
      raw_json: rawJson,
    },
  };
}

/**
 * True when the 14 digits form a real calendar timestamp. Done with UTC
 * arithmetic on the digits only - no timezone is involved, because none
 * should be: the value is device-local wall clock and stays so (R3).
 */
function isRealTimestamp(s) {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  if (y < 2000 || y > 2099) return false;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * The reply header block, as an ordered list of [name, value] pairs.
 *
 * Mirrors what DigiSME's IIS sends (minus its CORS/CSP noise): status 200,
 * `Cache-Control: private`, `Content-Length: 0`, the octet-stream type, the
 * `response_code`, and for a poll the two EMPTY command headers, then
 * `Connection: close`. Node adds `Date`, which the IIS reply also carried.
 */
function buildAckHeaders(kind) {
  const headers = [
    ["Cache-Control", "private"],
    ["Content-Length", "0"],
    ["Content-Type", "application/octet-stream"],
  ];
  if (kind === ACK_OK) {
    headers.push(["response_code", ACK_OK]);
  } else if (kind === ACK_NO_CMD) {
    headers.push(["response_code", ACK_NO_CMD]);
    headers.push(["cmd_id", ""]);
    headers.push(["cmd_code", ""]);
  } else {
    throw new Error(`unknown ack kind ${kind}`);
  }
  headers.push(["Connection", "close"]);
  return headers;
}

/**
 * Parse a raw HTTP reply (as the fixture files hold it, or as a test reads
 * it off a socket) into {statusLine, headers} with lower-cased names. Used
 * by the tests and the fake-device script so they assert on the protocol
 * header and never on the status line alone.
 */
function parseReplyHeaders(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer);
  const endOfHeaders = text.indexOf("\r\n\r\n");
  const head = endOfHeaders === -1 ? text : text.slice(0, endOfHeaders);
  const lines = head.split("\r\n");
  const statusLine = lines.shift() || "";
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
  }
  return { statusLine, headers };
}

module.exports = {
  REQUEST_PUNCH,
  REQUEST_POLL,
  ACK_OK,
  ACK_NO_CMD,
  DEFAULT_MAX_BODY_BYTES,
  headerValue,
  classifyRequest,
  readEnvelope,
  parsePunchBody,
  isRealTimestamp,
  buildAckHeaders,
  parseReplyHeaders,
};
