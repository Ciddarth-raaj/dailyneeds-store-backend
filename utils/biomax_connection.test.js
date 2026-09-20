/**
 * Connection state, and its independence from the administrative status.
 *
 *   node --test utils/biomax_connection.test.js
 *
 * The thing these pin is the one that costs money to get wrong: a terminal
 * that stopped talking to DNDS must not read as healthy because somebody
 * left its location period open, and a terminal in a quiet outlet must not
 * read as dead because nobody punched on it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONNECTION,
  classifyConnection,
  readThresholds,
  summarise,
  withConnection,
} = require("./biomax_connection");

const NOW = Date.UTC(2026, 8, 20, 12, 40, 0); // 2026-09-20 12:40:00 UTC
const at = (minutesAgo) => {
  const d = new Date(NOW - minutesAgo * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const classify = (lastSeen, extra = {}) => classifyConnection(lastSeen, { now: NOW, env: {}, ...extra });

describe("the three ages and the absence", () => {
  it("a poll a few minutes ago is Connected", () => {
    const got = classify(at(5));
    assert.equal(got.connection_status, CONNECTION.CONNECTED);
    assert.equal(got.seconds_since_seen, 300);
  });

  it("past the stale threshold but inside the offline one is Stale", () => {
    assert.equal(classify(at(20)).connection_status, CONNECTION.STALE);
  });

  it("past the offline threshold is Offline", () => {
    assert.equal(classify(at(180)).connection_status, CONNECTION.OFFLINE);
  });

  it("a device that has never contacted DNDS is Never Seen, with no age", () => {
    for (const empty of [null, undefined, ""]) {
      const got = classify(empty);
      assert.equal(got.connection_status, CONNECTION.NEVER_SEEN);
      assert.equal(got.seconds_since_seen, null);
    }
  });

  it("the boundaries belong to the gentler state", () => {
    assert.equal(classify(at(15)).connection_status, CONNECTION.CONNECTED);
    assert.equal(classify(at(60)).connection_status, CONNECTION.STALE);
  });

  it("a last_seen_at in the future is clock skew, not death", () => {
    const got = classify(at(-30));
    assert.equal(got.connection_status, CONNECTION.CONNECTED);
    assert.equal(got.seconds_since_seen, 0);
  });

  it("the timestamp is read as UTC, not as the reader's local time", () => {
    // Were this parsed in a non-UTC zone, the age would be off by the offset.
    assert.equal(classify("2026-09-20 12:34:18").seconds_since_seen, 342);
  });
});

describe("last_punch_at never decides connectivity", () => {
  it("a recent poll with a punch from this morning is still Connected", () => {
    const row = { dev_id: "DN1", status: "ACTIVE", last_seen_at: at(2), last_punch_at: at(400) };
    assert.equal(withConnection(row, { now: NOW, env: {} }).connection_status, CONNECTION.CONNECTED);
  });

  it("a fresh punch cannot rescue a device that stopped polling", () => {
    // Contrived (a punch touches last_seen too), but it states the rule: the
    // classifier is handed last_seen_at and reads nothing else.
    const row = { dev_id: "DN2", last_seen_at: at(400), last_punch_at: at(1) };
    assert.equal(withConnection(row, { now: NOW, env: {} }).connection_status, CONNECTION.OFFLINE);
  });
});

describe("assignment and connection are independent", () => {
  const rows = [
    { dev_id: "A", status: "ACTIVE", last_seen_at: at(1) },
    { dev_id: "B", status: "ACTIVE", last_seen_at: at(300) },
    { dev_id: "C", status: "INACTIVE", last_seen_at: at(1) },
    { dev_id: "D", status: "INACTIVE", last_seen_at: null },
  ].map((r) => withConnection(r, { now: NOW, env: {} }));

  it("an Active device can be Offline and keeps saying Active", () => {
    const b = rows[1];
    assert.equal(b.status, "ACTIVE");
    assert.equal(b.connection_status, CONNECTION.OFFLINE);
  });

  it("an Inactive device that is still polling reads Inactive + Connected", () => {
    const c = rows[2];
    assert.equal(c.status, "INACTIVE");
    assert.equal(c.connection_status, CONNECTION.CONNECTED);
  });

  it("classifying never rewrites the administrative status", () => {
    assert.deepEqual(rows.map((r) => r.status), ["ACTIVE", "ACTIVE", "INACTIVE", "INACTIVE"]);
  });

  it("the header counts every device exactly once", () => {
    assert.deepEqual(summarise(rows), { connected: 2, stale: 0, offline: 1, never_seen: 1, total: 4 });
  });
});

describe("the thresholds are configuration, not a constant in the code", () => {
  it("the environment moves both of them", () => {
    const env = { BIOMAX_DEVICE_STALE_SECONDS: "60", BIOMAX_DEVICE_OFFLINE_SECONDS: "120" };
    assert.deepEqual(readThresholds(env), { staleSeconds: 60, offlineSeconds: 120 });
    assert.equal(classifyConnection(at(5), { now: NOW, env }).connection_status, CONNECTION.OFFLINE);
  });

  it("a nonsense value falls back to the documented default rather than to zero", () => {
    assert.deepEqual(readThresholds({ BIOMAX_DEVICE_STALE_SECONDS: "soon" }), { staleSeconds: 900, offlineSeconds: 3600 });
  });

  it("an offline threshold below the stale one cannot hide Stale entirely", () => {
    const env = { BIOMAX_DEVICE_STALE_SECONDS: "600", BIOMAX_DEVICE_OFFLINE_SECONDS: "60" };
    assert.deepEqual(readThresholds(env), { staleSeconds: 600, offlineSeconds: 600 });
  });
});
