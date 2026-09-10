/**
 * Flood protection for UNREGISTERED devices (R13).
 *
 * A Cloud ID with no `biomax_device` row is stored and acknowledged (D3), so
 * an unknown or misbehaving unit could otherwise grow the punch table without
 * limit. Three in-memory caps bound that:
 *
 *   perMinute        stored punches per unknown dev_id per minute
 *   perDay           stored punches per unknown dev_id per calendar day
 *   devicesPerDay    distinct unknown dev_ids admitted per calendar day
 *
 * Beyond a cap the frame is NOT stored but IS still acknowledged, so a
 * runaway device cannot turn into a retry storm against us. Registered
 * devices are never capped: their retransmissions are already row-free under
 * the unique key (R2).
 *
 * Counters live in memory and reset on restart. That is acceptable: the
 * purpose is bounding growth, not accounting. The clock is injected so the
 * tests can move it.
 */

const DEFAULTS = Object.freeze({
  perMinute: 30,
  perDay: 2000,
  devicesPerDay: 20,
});

function createFloodGuard(options = {}) {
  const limits = { ...DEFAULTS, ...(options.limits || {}) };
  const now = options.now || (() => Date.now());

  const minuteCounts = new Map(); // dev_id -> {bucket, count}
  const dayCounts = new Map(); // dev_id -> {bucket, count}
  let dayDevices = { bucket: null, ids: new Set() };

  const minuteBucket = (t) => Math.floor(t / 60000);
  const dayBucket = (t) => Math.floor(t / 86400000);

  /**
   * Ask whether a punch from an unknown device may be stored. Counts it if
   * so. Returns {allowed: boolean, reason: string|null}.
   */
  function admit(devId) {
    const t = now();
    const mb = minuteBucket(t);
    const db = dayBucket(t);

    if (dayDevices.bucket !== db) dayDevices = { bucket: db, ids: new Set() };
    if (!dayDevices.ids.has(devId) && dayDevices.ids.size >= limits.devicesPerDay) {
      return { allowed: false, reason: `more than ${limits.devicesPerDay} unregistered devices today` };
    }

    const m = minuteCounts.get(devId);
    const minute = m && m.bucket === mb ? m : { bucket: mb, count: 0 };
    if (minute.count >= limits.perMinute) {
      minuteCounts.set(devId, minute);
      return { allowed: false, reason: `more than ${limits.perMinute} punches this minute` };
    }

    const d = dayCounts.get(devId);
    const day = d && d.bucket === db ? d : { bucket: db, count: 0 };
    if (day.count >= limits.perDay) {
      dayCounts.set(devId, day);
      return { allowed: false, reason: `more than ${limits.perDay} punches today` };
    }

    minute.count += 1;
    day.count += 1;
    minuteCounts.set(devId, minute);
    dayCounts.set(devId, day);
    dayDevices.ids.add(devId);
    return { allowed: true, reason: null };
  }

  /**
   * At most one "true" per key per hour - for writing one raw-request row
   * per capped device (or per misconfigured shift) per hour rather than one
   * per frame.
   */
  const hourly = new Map();
  function oncePerHour(key) {
    const t = now();
    const hb = Math.floor(t / 3600000);
    if (hourly.get(key) === hb) return false;
    hourly.set(key, hb);
    return true;
  }

  return { admit, oncePerHour, limits };
}

module.exports = { createFloodGuard, DEFAULTS };
