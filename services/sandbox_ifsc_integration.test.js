/**
 * IFSC lookup, through the REAL SandboxClient.
 *
 *   node --test services/sandbox_ifsc_integration.test.js
 *
 * ============================== WHY THIS FILE EXISTS SEPARATELY ============
 *
 * `sandbox_ifsc.test.js` fakes `client.request()`. That is the right boundary
 * for asking what the service does with an answer - and the wrong one for
 * asking whether it ever GETS an answer, because it hands the service a
 * `{ data: { BANK, BRANCH } }` that the real client would never have produced.
 *
 * It did not, in fact, produce it. Sandbox wraps most products in
 * `{ code: 200, data: {...} }`, and the client required that envelope; the
 * IFSC endpoint returns the record itself. A perfectly valid branch code was
 * therefore classified as an unexpected provider response before
 * `lookupIfsc()` saw a single field. The fake hid it completely.
 *
 * So these tests replace only the HTTP transport - the axios call - and run
 * everything above it for real: the client, its classification, its envelope
 * handling and the bank service on top. The transport is a function, so no
 * test can reach Sandbox and none needs a token.
 */
const test = require("node:test");
const assert = require("node:assert");

const clientFactory = require("./sandbox_client");
const { SandboxError, FAILURE } = require("./sandbox_client");
const { SandboxBankService } = require("./sandbox_bank");

const IFSC = "HDFC0000012";

/** The documented success body: the record itself, no envelope. */
const DOCUMENTED_IFSC_RESPONSE = {
  BANK: "HDFC Bank",
  IFSC: "HDFC0000012",
  BRANCH: "PARK STREET",
  ADDRESS: "2A, PARK STREET, KOLKATA 700016",
  CITY: "KOLKATA",
  DISTRICT: "KOLKATA",
  STATE: "WEST BENGAL",
  CENTRE: "KOLKATA",
  CONTACT: "+919831000000",
  MICR: "700240002",
  UPI: true,
  RTGS: true,
  NEFT: true,
  IMPS: true,
  SWIFT: null,
};

/** A SandboxService stand-in: a token and a base URL, nothing live. */
const fakeSandboxService = () => ({
  baseUrl: "https://api.sandbox.example",
  apiKey: "test-key",
  isEnabled: () => true,
  getAccessToken: async () => "test-token",
  invalidateAccessToken() {
    this.invalidated = (this.invalidated || 0) + 1;
  },
});

/** Replaces axios only. Records what was sent; returns what it was told to. */
function transport(reply) {
  const calls = [];
  const http = async (config) => {
    calls.push(config);
    return typeof reply === "function" ? reply(config, calls.length) : reply;
  };
  http.calls = calls;
  return http;
}

const service = (http) => new SandboxBankService(clientFactory(fakeSandboxService(), { http }));

/* ================= the documented shape, end to end ===================== */

test("THE DOCUMENTED RAW IFSC RESPONSE RESOLVES, THROUGH THE REAL CLIENT", async () => {
  // HTTP 200, no `{ code, data }` envelope - exactly what Sandbox returns.
  // This is the case that was broken.
  const http = transport({ status: 200, data: DOCUMENTED_IFSC_RESPONSE });
  const out = await service(http).lookupIfsc(IFSC);

  assert.deepStrictEqual(out, {
    exists: true,
    ifsc: IFSC,
    bank_name: "HDFC Bank",
    branch_name: "PARK STREET",
  });

  // Everything else in that body is ignored, not merely unstored.
  for (const leaked of ["ADDRESS", "CITY", "MICR", "UPI", "CONTACT", "STATE"]) {
    assert.ok(!(leaked in out), `${leaked} must not come back`);
  }
});

test("it is sent as an authenticated GET to the documented path", async () => {
  const http = transport({ status: 200, data: DOCUMENTED_IFSC_RESPONSE });
  await service(http).lookupIfsc(" hdfc 0000012 ");

  assert.strictEqual(http.calls.length, 1);
  const call = http.calls[0];
  assert.strictEqual(call.method, "GET");
  assert.strictEqual(call.url, `https://api.sandbox.example/bank/${IFSC}`);
  assert.strictEqual(call.headers.Authorization, "test-token");
  assert.strictEqual(call.headers["x-api-key"], "test-key");
  // A GET carries no body, and certainly no account number.
  assert.ok(!("data" in call), "no request body");
  assert.ok(!/accounts|penniless/.test(call.url));
});

test("an envelope is still honoured if Sandbox ever sends one", async () => {
  // The exemption is about ACCEPTING a raw body, not about refusing an
  // enveloped one: the client decides by what arrived, so either shape works
  // and a change at the provider needs no code change here.
  const http = transport({ status: 200, data: { code: 200, data: DOCUMENTED_IFSC_RESPONSE, transaction_id: "t1" } });
  const out = await service(http).lookupIfsc(IFSC);
  assert.strictEqual(out.bank_name, "HDFC Bank");
  assert.strictEqual(out.branch_name, "PARK STREET");
});

/* ================= failures still fail, for the right reason ============ */

test("A 404 IS STILL AN ANSWER ABOUT THE CODE, NOT A FAULT", async () => {
  const http = transport({ status: 404, data: { code: 404, message: "not found" } });
  const out = await service(http).lookupIfsc(IFSC);
  assert.deepStrictEqual(out, { exists: false, ifsc: IFSC, bank_name: null, branch_name: null });
});

test("AN ERROR ENVELOPE AT HTTP 200 IS STILL AN ERROR, EVEN FOR A RAW CALLER", async () => {
  // The exemption must not become a way for a provider error to read as a
  // record. A body carrying its own `code` is judged by that code.
  const http = transport({ status: 200, data: { code: 404, message: "no such ifsc" } });
  const out = await service(http).lookupIfsc(IFSC);
  assert.strictEqual(out.exists, false, "a 200-wrapped 404 is still not found");

  for (const [code, category] of [
    [401, FAILURE.AUTH_FAILED],
    [403, FAILURE.NOT_ENTITLED],
    [429, FAILURE.RATE_LIMITED],
    [500, FAILURE.UNAVAILABLE],
  ]) {
    const h = transport({ status: 200, data: { code, message: "x" } });
    await assert.rejects(() => service(h).lookupIfsc(IFSC), { category }, `200-wrapped ${code}`);
  }
});

test("a non-200 status, a non-object body and a transport failure all still throw", async () => {
  for (const reply of [
    { status: 500, data: { code: 500 } },
    { status: 503, data: "<html>gateway</html>" },
    { status: 200, data: "not json" },
    { status: 200, data: null },
  ]) {
    await assert.rejects(
      () => service(transport(reply)).lookupIfsc(IFSC),
      (err) => err instanceof SandboxError,
      JSON.stringify(reply.status)
    );
  }

  // A dead connection.
  const dead = transport(() => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  });
  await assert.rejects(() => service(dead).lookupIfsc(IFSC), { category: FAILURE.UNAVAILABLE });

  // A timeout is reported as one.
  const slow = transport(() => {
    throw Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" });
  });
  await assert.rejects(() => service(slow).lookupIfsc(IFSC), { category: FAILURE.TIMEOUT });
});

test("a 200 raw body carrying neither name is unexpected, not a valid IFSC", async () => {
  const http = transport({ status: 200, data: { CITY: "KOLKATA", MICR: "700240002" } });
  await assert.rejects(() => service(http).lookupIfsc(IFSC), { category: FAILURE.UNEXPECTED });
});

/* ================= the 401 retry, inherited not rebuilt ================= */

test("THE SHARED 401 RETRY STILL APPLIES TO THIS CALL", async () => {
  // The point of going through the shared client: an aged-out token is
  // dropped and the call is made once more, and the IFSC path gets that for
  // free rather than reimplementing it.
  const sandbox = fakeSandboxService();
  const http = transport((config, n) =>
    n === 1 ? { status: 401, data: { code: 401 } } : { status: 200, data: DOCUMENTED_IFSC_RESPONSE }
  );
  const svc = new SandboxBankService(clientFactory(sandbox, { http }));

  const out = await svc.lookupIfsc(IFSC);
  assert.strictEqual(out.bank_name, "HDFC Bank");
  assert.strictEqual(http.calls.length, 2, "one retry, not a loop");
  assert.strictEqual(sandbox.invalidated, 1, "the stale token was dropped");
});

/* ================= the exemption is narrow ============================== */

test("THE RAW EXEMPTION IS OPT-IN, AND THE PAID PATHS DO NOT TAKE IT", async () => {
  // Penny-Less and Aadhaar depend on `code: 200` meaning success. A bare
  // object must still be refused for them, or an error body missing its
  // envelope would read as a good result on a paid check.
  const raw = transport({ status: 200, data: { account_exists: true, name_at_bank: "SOMEBODY" } });
  await assert.rejects(
    () => service(raw).pennyLessVerify({ account_number: "1234567890", ifsc: IFSC }),
    { category: FAILURE.UNEXPECTED },
    "Penny-Less must NOT accept an unenveloped body"
  );

  // Enveloped, it works exactly as before - unchanged contract.
  const enveloped = transport({
    status: 200,
    data: { code: 200, data: { account_exists: true, name_at_bank: "SOMEBODY" }, transaction_id: "t9" },
  });
  const ok = await service(enveloped).pennyLessVerify({ account_number: "1234567890", ifsc: IFSC });
  assert.strictEqual(ok.account_exists, true);
  assert.strictEqual(ok.name_at_bank, "SOMEBODY");
  assert.strictEqual(ok.transaction_id, "t9");

  // And only the IFSC call asks for the exemption.
  const src = require("fs").readFileSync(require("path").join(__dirname, "sandbox_bank.js"), "utf8");
  assert.strictEqual((src.match(/rawResponse: true/g) || []).length, 1, "exactly one raw caller");
  const pennyless = src.slice(src.indexOf("async pennyLessVerify"), src.indexOf("static normaliseIfsc"));
  assert.ok(!/rawResponse/.test(pennyless), "Penny-Less must not opt in");

  const aadhaar = require("fs").readFileSync(require("path").join(__dirname, "sandbox_aadhaar.js"), "utf8");
  assert.ok(!/rawResponse/.test(aadhaar), "Aadhaar must not opt in");
});

test("nothing from the provider body reaches the error a caller sees", async () => {
  const http = transport({
    status: 500,
    data: { code: 500, message: "internal", debug: "SECRET-TOKEN", stack: "at foo()" },
  });
  await assert.rejects(
    () => service(http).lookupIfsc(IFSC),
    (err) => {
      const serialised = JSON.stringify({ message: err.message, ...err });
      for (const secret of ["SECRET-TOKEN", "internal", "at foo()", "test-key", "test-token"]) {
        assert.ok(!serialised.includes(secret), `${secret} must not survive`);
      }
      return true;
    }
  );
});
