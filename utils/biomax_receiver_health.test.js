/**
 * The receiver health probe, and what it refuses to say.
 *
 *   node --test utils/biomax_receiver_health.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { RECEIVER, checkReceiverHealth, defaultProbe } = require("./biomax_receiver_health");

const probeReturning = (value) => () => Promise.resolve(value);
const probeFailing = (message) => () => Promise.reject(new Error(message));

describe("reading the receiver's answer", () => {
  it("ok + db true is Online, and the last punch time is passed through", async () => {
    const got = await checkReceiverHealth({
      env: {},
      probe: probeReturning({ statusCode: 200, body: { ok: true, db: true, last_punch_received: "2026-09-20 12:34:18", node: "14.21.3" } }),
    });
    assert.equal(got.status, RECEIVER.ONLINE);
    assert.equal(got.last_punch_received, "2026-09-20 12:34:18");
  });

  it("a receiver that is up but cannot reach its database is Degraded, not Online", async () => {
    const got = await checkReceiverHealth({
      env: {},
      probe: probeReturning({ statusCode: 503, body: { ok: false, db: false, last_punch_received: null } }),
    });
    assert.equal(got.status, RECEIVER.DEGRADED);
  });

  it("nothing internal is passed on - no host, no port, no node version", async () => {
    const got = await checkReceiverHealth({
      env: { BIOMAX_PORT: "7005", BIOMAX_HEALTH_HOST: "10.0.3.14" },
      probe: probeReturning({ statusCode: 200, body: { ok: true, db: true, last_punch_received: null, node: "14.21.3", host: "10.0.3.14" } }),
    });
    assert.deepEqual(Object.keys(got).sort(), ["db", "last_punch_received", "ok", "status"]);
    assert.equal(JSON.stringify(got).includes("10.0.3.14"), false);
    assert.equal(JSON.stringify(got).includes("14.21.3"), false);
  });
});

describe("a probe that fails is an answer, never an exception", () => {
  it("a timeout resolves to Unavailable", async () => {
    const got = await checkReceiverHealth({ env: {}, probe: probeFailing("timeout") });
    assert.equal(got.status, RECEIVER.UNAVAILABLE);
    assert.equal(got.reason, "timeout");
  });

  it("a refused connection resolves to Unavailable with a fixed word, not the socket error", async () => {
    const got = await checkReceiverHealth({
      env: {},
      probe: probeFailing("connect ECONNREFUSED 127.0.0.1:7005"),
    });
    assert.equal(got.status, RECEIVER.UNAVAILABLE);
    assert.equal(got.reason, "unreachable");
    assert.equal(JSON.stringify(got).includes("7005"), false);
  });

  it("an unparseable body is Unavailable rather than a half-read truth", async () => {
    const got = await checkReceiverHealth({ env: {}, probe: probeFailing("unreadable") });
    assert.equal(got.status, RECEIVER.UNAVAILABLE);
  });
});

describe("the real HTTP probe", () => {
  it("reads a live /healthz over loopback", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, db: true, last_punch_received: "2026-09-20 12:00:00" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const got = await checkReceiverHealth({ env: { BIOMAX_PORT: String(server.address().port) } });
      assert.equal(got.status, RECEIVER.ONLINE);
      assert.equal(got.last_punch_received, "2026-09-20 12:00:00");
    } finally {
      server.close();
    }
  });

  it("gives up on a receiver that never answers, inside the configured budget", async () => {
    const server = http.createServer(() => {}); // accepts, never replies
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const started = Date.now();
      const got = await checkReceiverHealth({
        env: { BIOMAX_PORT: String(server.address().port), BIOMAX_HEALTH_TIMEOUT_MS: "150" },
      });
      assert.equal(got.status, RECEIVER.UNAVAILABLE);
      assert.ok(Date.now() - started < 3000, "the probe must not hold the request open");
    } finally {
      server.close();
    }
  });

  it("is exported so nothing else re-implements the call", () => {
    assert.equal(typeof defaultProbe, "function");
  });
});
