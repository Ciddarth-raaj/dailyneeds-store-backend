/**
 *   node --test services/retailpilot_spectra.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const makeClient = require("./retailpilot_spectra");

const CFG = { baseUrl: "https://rp.example/runway", apiKey: "k", product: "runway", pageSize: 2000, timeoutMs: 1000 };
const ok = (rows, has_next = false) => ({ status: 200, data: { data: rows, pagination: { has_next }, meta: {} } });
const httpErr = (status, body, headers = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: body, headers } });

function scripted(steps) {
  const calls = [];
  const http = async (req) => {
    calls.push(req);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { http, calls };
}

describe("SPECTRA client without a retry policy (existing syncs)", () => {
  it("makes one attempt and keeps its error message", async () => {
    const { http, calls } = scripted([httpErr(503, { error: "busy" })]);
    const c = makeClient(CFG, http, async () => assert.fail("must not sleep"));
    await assert.rejects(c.queryAll("SELECT 1"), /SPECTRA request failed \(HTTP 503\)/);
    assert.equal(calls.length, 1);
  });
  it("never sends the key anywhere but the header", async () => {
    const { http, calls } = scripted([ok([])]);
    await makeClient(CFG, http).queryAll("SELECT 1");
    assert.equal(calls[0].headers["X-Authentication"], "k");
    assert.ok(!JSON.stringify(calls[0].data).includes("\"k\""));
  });
});

describe("SPECTRA client with the opt-in retry policy", () => {
  const cfg = { ...CFG, retry: true };
  it("waits Retry-After on 429, then succeeds", async () => {
    const waits = [];
    const { http, calls } = scripted([httpErr(429, { error: "rate_limited" }, { "retry-after": "7" }), ok([{ a: 1 }])]);
    const rows = await makeClient(cfg, http, async (ms) => waits.push(ms)).queryAll("SELECT 1");
    assert.deepEqual(rows, [{ a: 1 }]);
    assert.deepEqual(waits, [7000]);
    assert.equal(calls.length, 2);
  });
  it("caps a long Retry-After", async () => {
    const waits = [];
    const { http } = scripted([httpErr(429, {}, { "retry-after": "9999" }), ok([])]);
    await makeClient(cfg, http, async (ms) => waits.push(ms)).queryAll("SELECT 1");
    assert.deepEqual(waits, [120000]);
  });
  it("backs off on 5xx and timeouts, and gives up after the attempts", async () => {
    const waits = [];
    const timeout = Object.assign(new Error("timeout of 1000ms exceeded"), { code: "ECONNABORTED" });
    const { http, calls } = scripted([httpErr(500, { error: "internal_error" }), timeout, httpErr(502, {}), httpErr(503, {})]);
    await assert.rejects(makeClient(cfg, http, async (ms) => waits.push(ms)).queryAll("SELECT 1"), (e) => e.status === 503 && e.retryable === true);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [2000, 8000, 30000]);
  });
  it("never retries an invalid query or an auth failure", async () => {
    for (const [status, code] of [[400, "parse_error"], [400, "whitelist_violation"], [400, "validation_error"], [401, "auth_error"], [403, null]]) {
      const { http, calls } = scripted([httpErr(status, { error: code, message: "no" })]);
      await assert.rejects(makeClient(cfg, http, async () => assert.fail("must not sleep")).queryAll("SELECT 1"), (e) => e.status === status && e.spectraError === code && e.retryable === false);
      assert.equal(calls.length, 1);
    }
  });
  it("treats an error body on HTTP 200 as final", async () => {
    const { http, calls } = scripted([{ status: 200, data: { error: "validation_error", detail: "subquery" } }]);
    await assert.rejects(makeClient(cfg, http).queryAll("SELECT 1"), (e) => e.spectraError === "validation_error" && !e.retryable);
    assert.equal(calls.length, 1);
  });
});

describe("keyset paging", () => {
  const cursorOf = (r) => ({ ts: r.t, slug: r.s });
  const build = (cursor, size) => `Q ${cursor ? `${cursor.ts}/${cursor.slug}` : "start"} ${size}`;

  it("asks for page 1 after the last row each time and stops on a short page", async () => {
    const { http, calls } = scripted([ok([{ t: "1", s: "a" }, { t: "2", s: "b" }]), ok([{ t: "3", s: "c" }])]);
    const seen = [];
    const res = await makeClient(CFG, http).queryKeyset(build, null, cursorOf, async (rows, cur) => seen.push([rows.length, cur]), { size: 2 });
    assert.deepEqual(calls.map((c) => [c.data.query, c.data.page, c.data.size]), [["Q start 2", 1, 2], ["Q 2/b 2", 1, 2]]);
    assert.deepEqual(res, { rows: 3, pages: 2, cursor: { ts: "3", slug: "c" } });
    assert.deepEqual(seen, [[2, { ts: "2", slug: "b" }], [1, { ts: "3", slug: "c" }]]);
  });
  it("an empty first page keeps the starting cursor", async () => {
    const { http } = scripted([ok([])]);
    const res = await makeClient(CFG, http).queryKeyset(build, { ts: "9", slug: "z" }, cursorOf, async () => {});
    assert.deepEqual(res, { rows: 0, pages: 1, cursor: { ts: "9", slug: "z" } });
  });
  it("refuses a query that does not advance (would loop forever)", async () => {
    const { http } = scripted([ok([{ t: "1", s: "a" }, { t: "1", s: "a" }])]);
    await assert.rejects(makeClient(CFG, http).queryKeyset(build, { ts: "1", slug: "a" }, cursorOf, async () => {}, { size: 2 }), /did not advance/);
  });
  it("a failed page fails the whole read (the caller keeps its watermark)", async () => {
    const { http } = scripted([ok([{ t: "1", s: "a" }, { t: "2", s: "b" }]), httpErr(400, { error: "parse_error" })]);
    const seen = [];
    await assert.rejects(makeClient(CFG, http).queryKeyset(build, null, cursorOf, async (rows) => seen.push(rows.length), { size: 2 }), /HTTP 400/);
    assert.deepEqual(seen, [2]);
  });
});
