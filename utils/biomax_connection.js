/**
 * Is the physical terminal talking to DNDS?
 *
 * ASSIGNMENT IS NOT CONNECTION. `status` (ACTIVE / INACTIVE) says only that
 * an administrator has an open location period for the device - it is a
 * paperwork state and it never changes by itself. Connection is the machine
 * fact: the terminal opened a TCP connection to the receiver recently, or it
 * did not. A device can be ACTIVE and unplugged, and INACTIVE while still
 * polling from a shelf. Both combinations are real and the screen shows
 * them side by side.
 *
 * `last_seen_at` IS THE SIGNAL, NEVER `last_punch_at`. The receiver calls
 * touchDevice(dev_id, {punch:false}) on EVERY request, including the bare
 * `receive_cmd` poll a device sends when nobody has touched it
 * (biomax/receiver.js). `last_punch_at` only moves when an employee puts a
 * face to the terminal, so a healthy terminal in a quiet outlet would look
 * dead by that measure all night.
 *
 * THE THRESHOLDS ARE CONFIGURED, NOT DEDUCED. The BM70W's poll interval is
 * a setting on the terminal and this codebase has no proof of what it is in
 * production: the only cadence recorded anywhere is the ~3 minute retry of
 * an UNACKNOWLEDGED punch (docs/biomax-attendance-part1.md R1,
 * test_support/biomax/README.md), which is a retransmit timer, not a poll
 * timer. So the defaults are deliberately loose - 15 minutes to Stale,
 * 60 minutes to Offline - and both are env-tunable. Tighten them once a
 * week of biomax_device.last_seen_at from production shows the real gap
 * between polls; loose thresholds under-report a dead terminal for a while,
 * tight ones cry wolf at every outlet every hour, and only one of those
 * gets ignored by the people who must act on it.
 *
 * Timestamps here are the UTC wall-clock strings the repository formats
 * ('YYYY-MM-DD HH:MM:SS'): biomax_device.last_seen_at is written with
 * MySQL NOW(3) on a server that runs in UTC (see utils/istDate.js). They
 * are parsed as UTC explicitly, never handed to `new Date(string)`, whose
 * treatment of a space-separated string is implementation-defined.
 */

const CONNECTION = {
  CONNECTED: "CONNECTED",
  STALE: "STALE",
  OFFLINE: "OFFLINE",
  NEVER_SEEN: "NEVER_SEEN",
};

const DEFAULT_STALE_SECONDS = 15 * 60;
const DEFAULT_OFFLINE_SECONDS = 60 * 60;

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/** 'YYYY-MM-DD HH:MM:SS' (UTC) -> epoch millis, or null if unparseable. */
function parseUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const m = DATETIME_RE.exec(String(value).trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function positiveInt(value, fallback) {
  const n = Number(String(value === undefined || value === null ? "" : value).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** The two thresholds, from the environment, with Offline never below Stale. */
function readThresholds(env = process.env) {
  const staleSeconds = positiveInt(env.BIOMAX_DEVICE_STALE_SECONDS, DEFAULT_STALE_SECONDS);
  const offlineSeconds = positiveInt(env.BIOMAX_DEVICE_OFFLINE_SECONDS, DEFAULT_OFFLINE_SECONDS);
  return { staleSeconds, offlineSeconds: Math.max(staleSeconds, offlineSeconds) };
}

/**
 * @param {string|Date|null} lastSeenAt UTC 'YYYY-MM-DD HH:MM:SS'
 * @returns {{connection_status: string, seconds_since_seen: number|null}}
 */
function classifyConnection(lastSeenAt, options = {}) {
  const env = readThresholds(options.env);
  const staleSeconds = positiveInt(options.staleSeconds, env.staleSeconds);
  const offlineSeconds = Math.max(staleSeconds, positiveInt(options.offlineSeconds, env.offlineSeconds));
  const seenMs = parseUtc(lastSeenAt);
  if (seenMs === null) {
    return { connection_status: CONNECTION.NEVER_SEEN, seconds_since_seen: null };
  }
  const nowMs = options.now === undefined ? Date.now() : Number(options.now);
  // A clock skew that puts last_seen_at in the future is not a reason to
  // call a terminal dead: the floor is 0, and it reads as Connected.
  const seconds = Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  let connection_status = CONNECTION.CONNECTED;
  if (seconds > offlineSeconds) connection_status = CONNECTION.OFFLINE;
  else if (seconds > staleSeconds) connection_status = CONNECTION.STALE;
  return { connection_status, seconds_since_seen: seconds };
}

/** Add the connection fields to a device row read from the repository. */
function withConnection(row, options = {}) {
  return { ...row, ...classifyConnection(row ? row.last_seen_at : null, options) };
}

/** {connected, stale, offline, never_seen} over already-classified rows. */
function summarise(rows) {
  const counts = { connected: 0, stale: 0, offline: 0, never_seen: 0, total: 0 };
  for (const row of rows || []) {
    counts.total += 1;
    if (row.connection_status === CONNECTION.CONNECTED) counts.connected += 1;
    else if (row.connection_status === CONNECTION.STALE) counts.stale += 1;
    else if (row.connection_status === CONNECTION.OFFLINE) counts.offline += 1;
    else counts.never_seen += 1;
  }
  return counts;
}

module.exports = {
  CONNECTION,
  DEFAULT_STALE_SECONDS,
  DEFAULT_OFFLINE_SECONDS,
  classifyConnection,
  parseUtc,
  readThresholds,
  summarise,
  withConnection,
};
