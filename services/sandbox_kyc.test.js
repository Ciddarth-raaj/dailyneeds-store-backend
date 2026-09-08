/**
 * Stage 0C / C2 — the shared Sandbox transport, and the two new products.
 *
 *   node --test services/sandbox_kyc.test.js
 *
 * Sandbox is never called here. What is tested is the layer between our code
 * and theirs: that Aadhaar and Bank borrow the GST integration's
 * authentication rather than starting a second one, that a provider failure
 * becomes a stable internal category rather than a leaked payload, and that
 * the request shapes match the endpoints these were written against:
 *
 *   POST /kyc/aadhaar/okyc/otp          generate OTP
 *   POST /kyc/aadhaar/okyc/otp/verify   verify OTP
 *   GET  /bank/{ifsc}/accounts/{account_number}/penniless-verify
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildClient = require("./sandbox_client");
const { SandboxClient, SandboxError, FAILURE } = require("./sandbox_client");
const buildAadhaar = require("./sandbox_aadhaar");
const buildBank = require("./sandbox_bank");
const { SandboxBankService } = require("./sandbox_bank");
const kycConfig = require("../config/sandbox_kyc");

/** A stand-in for the live services/sandbox.js. */
const makeSandbox = (over = {}) => ({
  baseUrl: "https://test-api.sandbox.co.in",
  apiKey: "test-key",
  enabled: true,
  tokens: ["TOKEN-1", "TOKEN-2"],
  invalidated: 0,
  isEnabled() {
    return this.enabled;
  },
  async getAccessToken() {
    return this.tokens[Math.min(this.invalidated, this.tokens.length - 1)];
  },
  invalidateAccessToken() {
    this.invalidated += 1;
  },
  ...over,
});

/**
 * Replaces the client's HTTP transport for one test; every call is recorded.
 * The transport is injected rather than monkey-patched, so there is no way for
 * a test to fall through to a real Sandbox endpoint if a stub runs out.
 */
function withAxios(responses, client) {
  const calls = [];
  const impl = async (config) => {
    calls.push(config);
    if (responses.length === 0) throw new Error("unexpected HTTP call: no stubbed response left");
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const original = client ? client.http : null;
  if (client) client.http = impl;
  return {
    calls,
    restore: () => {
      if (client) client.http = original;
    },
  };
}

const okBody = (data) => ({ status: 200, data: { code: 200, transaction_id: "TXN-9", data } });

/* ================================================ 1/2. GST is untouched = */
describe("1/2. the existing GST integration is not disturbed", () => {
  const gstSrc = fs.readFileSync(path.join(__dirname, "sandbox.js"), "utf8");

  it("services/sandbox.js still owns authentication, unchanged", () => {
    assert.match(gstSrc, /const url = `\$\{this\.baseUrl\}\/authenticate`/);
    assert.match(gstSrc, /"x-api-key": this\.apiKey/);
    assert.match(gstSrc, /"x-api-secret": this\.apiSecret/);
    assert.match(gstSrc, /res\.data\.data && res\.data\.data\.access_token/);
    // The GST product calls are still there and still GST's own.
    assert.match(gstSrc, /\/gst\/compliance\/public\/gstin\/search/);
    assert.match(gstSrc, /gst\/compliance\/tax-payer\/gstrs\/gstr-2a\/b2b/);
  });

  it("and knows nothing about Aadhaar or bank verification", () => {
    for (const word of ["aadhaar", "okyc", "penniless", "penny"]) {
      assert.ok(!new RegExp(word, "i").test(gstSrc), `services/sandbox.js must not mention ${word}`);
    }
  });

  it("2. the new client BORROWS that service rather than authenticating again", () => {
    const src = fs.readFileSync(path.join(__dirname, "sandbox_client.js"), "utf8");
    assert.match(src, /this\.sandbox\.getAccessToken\(\)/);
    assert.match(src, /this\.sandbox\.invalidateAccessToken\(\)/);
    // Comments are allowed to NAME the auth endpoint - the code must not call
    // it - so the assertions below run against the code alone.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // No second token cache, and no second /authenticate call.
    assert.ok(!/\/authenticate/.test(code), "the shared client must not authenticate on its own");
    assert.ok(!/x-api-secret/.test(code), "the secret belongs to the auth service alone");
    assert.ok(!/accessToken\s*=/.test(code), "no second token cache");
  });

  it("Aadhaar and bank business logic live outside the GST module", () => {
    for (const f of ["sandbox_aadhaar.js", "sandbox_bank.js"]) {
      assert.ok(fs.existsSync(path.join(__dirname, f)), `${f} must exist`);
    }
    const aadhaar = fs.readFileSync(path.join(__dirname, "sandbox_aadhaar.js"), "utf8");
    assert.ok(!/gst/i.test(aadhaar), "no GST in the Aadhaar module");
  });
});

/* ==================================================== the shared client = */
describe("the shared client", () => {
  it("sends the raw JWT, the api key and the version, like the GST calls do", async () => {
    const sandbox = makeSandbox();
    const client = buildClient(sandbox);
    const a = withAxios([okBody({ reference_id: "REF-1" })], client);
    try {
      await client.request({ method: "POST", path: "/kyc/aadhaar/okyc/otp", body: { a: 1 } });
      assert.equal(a.calls.length, 1);
      const c = a.calls[0];
      assert.equal(c.url, "https://test-api.sandbox.co.in/kyc/aadhaar/okyc/otp");
      assert.equal(c.headers.Authorization, "TOKEN-1", "raw JWT, no Bearer prefix");
      assert.equal(c.headers["x-api-key"], "test-key");
      assert.equal(c.headers["x-api-version"], kycConfig.apiVersion);
      assert.equal(c.timeout, kycConfig.timeoutMs);
    } finally {
      a.restore();
    }
  });

  it("retries once on a 401 with a fresh token, and only once", async () => {
    const sandbox = makeSandbox();
    const client = buildClient(sandbox);
    const a = withAxios([{ status: 401, data: { code: 401 } }, okBody({ ok: true })], client);
    try {
      await client.request({ method: "POST", path: "/x", body: {} });
      assert.equal(a.calls.length, 2);
      assert.equal(sandbox.invalidated, 1, "the stale token was dropped");
      assert.equal(a.calls[1].headers.Authorization, "TOKEN-2", "and a new one used");
    } finally {
      a.restore();
    }
  });

  it("a second 401 is an auth failure, not an infinite retry", async () => {
    const client = buildClient(makeSandbox());
    const a = withAxios([{ status: 401, data: { code: 401 } }, { status: 401, data: { code: 401 } }], client);
    try {
      await assert.rejects(() => client.request({ method: "POST", path: "/x", body: {} }), /rejected our credentials/);
      assert.equal(a.calls.length, 2);
    } finally {
      a.restore();
    }
  });

  it("maps every provider status onto a stable internal category", () => {
    const cases = [
      [401, FAILURE.AUTH_FAILED],
      [402, FAILURE.NOT_ENTITLED],
      [403, FAILURE.NOT_ENTITLED],
      [404, FAILURE.NOT_FOUND],
      [408, FAILURE.TIMEOUT],
      [429, FAILURE.RATE_LIMITED],
      [400, FAILURE.INVALID_REQUEST],
      [422, FAILURE.INVALID_REQUEST],
      [500, FAILURE.UNAVAILABLE],
      [503, FAILURE.UNAVAILABLE],
      [418, FAILURE.UNEXPECTED],
    ];
    for (const [status, expected] of cases) {
      assert.equal(SandboxClient.classify(status, null), expected, `HTTP ${status}`);
      // Sandbox also reports its own code in the body; a 200 carrying
      // code 401 is still an auth failure.
      assert.equal(SandboxClient.classify(200, { code: status }), expected, `body code ${status}`);
    }
  });

  it("a network timeout is a timeout, not an unexplained 500", async () => {
    const client = buildClient(makeSandbox());
    const err = new Error("timeout of 30000ms exceeded");
    err.code = "ECONNABORTED";
    const a = withAxios([err], client);
    try {
      await assert.rejects(() => client.request({ method: "POST", path: "/x", body: {} }), (e) => {
        assert.equal(e.category, FAILURE.TIMEOUT);
        return true;
      });
    } finally {
      a.restore();
    }
  });

  it("never lets a provider payload reach the caller", async () => {
    const client = buildClient(makeSandbox());
    const a = withAxios([
      { status: 400, data: { code: 400, message: "internal-secret-detail", stack: "at Foo (bar.js)" } },
    ], client);
    try {
      await client.request({ method: "POST", path: "/x", body: {} });
      assert.fail("should have thrown");
    } catch (err) {
      const text = JSON.stringify({ message: err.message, ...err });
      assert.ok(!text.includes("internal-secret-detail"));
      assert.ok(!text.includes("bar.js"));
      assert.equal(err.category, FAILURE.INVALID_REQUEST);
    } finally {
      a.restore();
    }
  });

  it("refuses when Sandbox is not configured at all", async () => {
    const client = buildClient(makeSandbox({ enabled: false }));
    await assert.rejects(() => client.request({ method: "POST", path: "/x" }), /not configured/);
    assert.equal(client.isEnabled(), false);
  });

  it("logs a category and a path, never a body", () => {
    const src = fs.readFileSync(path.join(__dirname, "sandbox_client.js"), "utf8");
    const logBlock = src.slice(src.indexOf("_log(category, path, ref)"));
    assert.ok(!/body/.test(logBlock), "the log must not carry the request body");
    assert.match(logBlock, /description: `Sandbox call to \$\{path\} failed/);
  });
});

/* ======================================================== Aadhaar OKYC == */
describe("the Aadhaar OKYC service", () => {
  const AADHAAR = "222222222229";

  it("posts the documented generate-OTP shape", async () => {
    const client = buildClient(makeSandbox());
    const service = buildAadhaar(client);
    const a = withAxios([okBody({ reference_id: "REF-77", message: "OTP sent successfully" })], client);
    try {
      const res = await service.generateOtp(AADHAAR);
      assert.equal(res.reference_id, "REF-77");
      const body = a.calls[0].data;
      assert.equal(a.calls[0].url, "https://test-api.sandbox.co.in/kyc/aadhaar/okyc/otp");
      assert.equal(a.calls[0].method, "POST");
      assert.equal(body["@entity"], "in.co.sandbox.kyc.aadhaar.okyc.otp.request");
      assert.equal(body.aadhaar_number, AADHAAR);
      assert.equal(body.consent, "y");
      assert.ok(body.reason, "a stated purpose is sent");
    } finally {
      a.restore();
    }
  });

  it("posts the documented verify-OTP shape and returns only mapped demographics", async () => {
    const client = buildClient(makeSandbox());
    const service = buildAadhaar(client);
    const a = withAxios([
      okBody({
        reference_id: "REF-77",
        status: "VALID",
        name: "Ramesh Kumar",
        date_of_birth: "01-02-1990",
        gender: "M",
        year_of_birth: "1990",
        address: { house: "12", street: "Main Road", district: "Chennai", state: "TN", pincode: "600001", country: "India" },
        photo: "BASE64IMAGEDATA",
      }),
    ], client);
    try {
      const res = await service.verifyOtp("REF-77", "123456");
      const body = a.calls[0].data;
      assert.equal(a.calls[0].url, "https://test-api.sandbox.co.in/kyc/aadhaar/okyc/otp/verify");
      assert.equal(body["@entity"], "in.co.sandbox.kyc.aadhaar.okyc.request");
      assert.equal(body.reference_id, "REF-77");
      assert.equal(body.otp, "123456");

      assert.equal(res.demographics.name, "Ramesh Kumar");
      assert.equal(res.demographics.date_of_birth, "01-02-1990");
      assert.equal(res.demographics.address, "12, Main Road, Chennai, TN, 600001, India");
      // The photo is deliberately dropped: nothing uses it, and storing a
      // face nobody asked for is not a decision to make by accident.
      assert.equal(res.demographics.photo, undefined);
    } finally {
      a.restore();
    }
  });

  it("a status Sandbox does not call successful is a failure, never a pass", async () => {
    const client = buildClient(makeSandbox());
    const service = buildAadhaar(client);
    const a = withAxios([okBody({ reference_id: "R", status: "INVALID_OTP" })], client);
    try {
      await assert.rejects(() => service.verifyOtp("R", "000000"), /could not be verified/);
    } finally {
      a.restore();
    }
  });

  it("a generate-OTP response with no reference is an unexpected response", async () => {
    const client = buildClient(makeSandbox());
    const service = buildAadhaar(client);
    const a = withAxios([okBody({ message: "ok but nothing useful" })], client);
    try {
      await assert.rejects(() => service.generateOtp(AADHAAR), /did not return a reference/);
    } finally {
      a.restore();
    }
  });
});

/* ================================================== Penny-Less bank ===== */
describe("the Penny-Less bank service", () => {
  it("builds the documented path with both parameters encoded", async () => {
    const client = buildClient(makeSandbox());
    const service = buildBank(client);
    const a = withAxios([okBody({ account_exists: true, name_at_bank: "RAMESH KUMAR" })], client);
    try {
      const res = await service.pennyLessVerify({ account_number: "50100123456789", ifsc: "hdfc0001234" });
      assert.equal(
        a.calls[0].url,
        "https://test-api.sandbox.co.in/bank/HDFC0001234/accounts/50100123456789/penniless-verify"
      );
      assert.equal(a.calls[0].method, "GET");
      assert.equal(a.calls[0].data, undefined, "a GET carries no body");
      assert.equal(res.account_exists, true);
      assert.equal(res.name_at_bank, "RAMESH KUMAR");
    } finally {
      a.restore();
    }
  });

  it("normalises spacing and case before sending", () => {
    const clean = SandboxBankService.normalise({ account_number: "5010 0123 456789", ifsc: " hdfc0001234 " });
    assert.deepEqual(clean, { account_number: "50100123456789", ifsc: "HDFC0001234" });
  });

  it("refuses a malformed IFSC or account locally, before any call", async () => {
    const client = buildClient(makeSandbox());
    const service = buildBank(client);
    const a = withAxios([], client);
    try {
      await assert.rejects(() => service.pennyLessVerify({ account_number: "1", ifsc: "HDFC0001234" }), /6 to 20 digits/);
      await assert.rejects(() => service.pennyLessVerify({ account_number: "50100123456789", ifsc: "BAD" }), /not a valid IFSC/);
      await assert.rejects(() => service.pennyLessVerify({ ifsc: "HDFC0001234" }), /account_number is required/);
      await assert.rejects(() => service.pennyLessVerify({ account_number: "50100123456789" }), /ifsc is required/);
      assert.equal(a.calls.length, 0, "not one paid call was spent");
    } finally {
      a.restore();
    }
  });

  it("an unknown account is a RESULT, not an exception", async () => {
    const client = buildClient(makeSandbox());
    const service = buildBank(client);
    const a = withAxios([{ status: 404, data: { code: 404 } }], client);
    try {
      const res = await service.pennyLessVerify({ account_number: "50100123456789", ifsc: "HDFC0001234" });
      assert.equal(res.account_exists, false);
      assert.equal(res.name_at_bank, null);
    } finally {
      a.restore();
    }
  });

  it("account_exists false with a 200 is reported as such", async () => {
    const client = buildClient(makeSandbox());
    const service = buildBank(client);
    const a = withAxios([okBody({ account_exists: false, name_at_bank: null })], client);
    try {
      const res = await service.pennyLessVerify({ account_number: "50100123456789", ifsc: "HDFC0001234" });
      assert.equal(res.account_exists, false);
    } finally {
      a.restore();
    }
  });

  it("46. a missing entitlement says so plainly", async () => {
    const client = buildClient(makeSandbox());
    const service = buildBank(client);
    const a = withAxios([{ status: 403, data: { code: 403, message: "product not subscribed" } }], client);
    try {
      await assert.rejects(
        () => service.pennyLessVerify({ account_number: "50100123456789", ifsc: "HDFC0001234" }),
        /not enabled on the provider account/
      );
    } finally {
      a.restore();
    }
  });

  it("the account number is not in the log reference, though it is in the path", () => {
    const src = fs.readFileSync(path.join(__dirname, "sandbox_bank.js"), "utf8");
    const logRef = src.slice(src.indexOf("logRef:"), src.indexOf("logRef:") + 200);
    assert.match(logRef, /ifsc: clean\.ifsc/);
    assert.ok(!/account_number/.test(logRef), "the account number must not be in the log reference");
  });
});

/* ================================================= documented contracts = */
describe("the endpoint contracts are written down, not hard-coded in logic", () => {
  it("every path and entity string is configurable", () => {
    assert.equal(kycConfig.aadhaar.generateOtpPath, "/kyc/aadhaar/okyc/otp");
    assert.equal(kycConfig.aadhaar.verifyOtpPath, "/kyc/aadhaar/okyc/otp/verify");
    assert.equal(kycConfig.aadhaar.generateOtpEntity, "in.co.sandbox.kyc.aadhaar.okyc.otp.request");
    assert.equal(kycConfig.aadhaar.verifyOtpEntity, "in.co.sandbox.kyc.aadhaar.okyc.request");
    assert.equal(kycConfig.bank.pennyLessPathTemplate, "/bank/{ifsc}/accounts/{account_number}/penniless-verify");
    const src = fs.readFileSync(path.join(__dirname, "..", "config/sandbox_kyc.js"), "utf8");
    for (const v of [
      "SANDBOX_AADHAAR_OTP_PATH", "SANDBOX_AADHAAR_OTP_VERIFY_PATH",
      "SANDBOX_BANK_PENNYLESS_PATH", "SANDBOX_KYC_API_VERSION",
    ]) {
      assert.match(src, new RegExp(v), `${v} must be overridable`);
    }
  });

  it("and the doc URLs they came from are recorded next to them", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "config/sandbox_kyc.js"), "utf8");
    assert.match(src, /developer\.sandbox\.co\.in\/api-reference\/kyc\/aadhaar\/endpoints\/generate_otp/);
    assert.match(src, /developer\.sandbox\.co\.in\/api-reference\/kyc\/aadhaar\/endpoints\/verify_otp/);
    assert.match(src, /developer\.sandbox\.co\.in\/api-reference\/kyc\/bank\/endpoints\/penny_less/);
  });
});
