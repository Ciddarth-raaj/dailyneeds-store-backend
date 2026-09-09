/**
 * The Sandbox side of the IFSC lookup.
 *
 *   node --test services/sandbox_ifsc.test.js
 *
 * The transport is faked at the `client.request` boundary, so no test can
 * reach Sandbox, and no test needs a token.
 *
 * What is worth pinning here rather than in the usecase: that this reuses the
 * one shared client - and therefore the one token cache, the 401 retry, the
 * timeout and the error mapping that already exist - instead of growing a
 * second authentication path beside them.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { SandboxBankService } = require("./sandbox_bank");
const { SandboxError, FAILURE } = require("./sandbox_client");
const kycConfig = require("../config/sandbox_kyc");

const IFSC = "SBIN0010507";

/** A client that records the call and returns whatever it was told to. */
function fakeClient(reply) {
  return {
    requests: [],
    isEnabled: () => true,
    async request(args) {
      this.requests.push(args);
      if (typeof reply === "function") return reply(args);
      return reply;
    },
  };
}

const ok = (data) => ({ data, transaction_id: "txn-1", timestamp: null });

/* ======================= it calls the right thing, once ================== */

test("IT CALLS THE CONFIGURED IFSC PATH WITH THE NORMALISED CODE", async () => {
  const client = fakeClient(ok({ BANK: "State Bank of India", BRANCH: "Lawspet" }));
  const out = await new SandboxBankService(client).lookupIfsc(" sbin 0010507 ");

  assert.strictEqual(client.requests.length, 1);
  const req = client.requests[0];
  assert.strictEqual(req.method, kycConfig.bank.ifscMethod);
  assert.strictEqual(req.path, `/bank/${IFSC}`);
  assert.deepStrictEqual(out, {
    exists: true,
    ifsc: IFSC,
    bank_name: "State Bank of India",
    branch_name: "Lawspet",
  });
});

test("NO ACCOUNT NUMBER IS OR CAN BE SENT ON THIS PATH", async () => {
  // The Penny-Less path carries one; this one must not, and the method takes
  // no argument that could hold it.
  const client = fakeClient(ok({ BANK: "B", BRANCH: "Br" }));
  await new SandboxBankService(client).lookupIfsc(IFSC);

  const req = client.requests[0];
  assert.ok(!("body" in req) || req.body === null || req.body === undefined, "no request body");
  assert.ok(!/accounts|penniless/.test(req.path), "not the verification path");
  assert.strictEqual(SandboxBankService.prototype.lookupIfsc.length, 1, "one parameter: the IFSC");
});

test("the log reference carries the branch code and nothing else", async () => {
  const client = fakeClient(ok({ BANK: "B", BRANCH: "Br" }));
  await new SandboxBankService(client).lookupIfsc(IFSC);
  assert.deepStrictEqual(client.requests[0].logRef, { product: "bank_ifsc", ifsc: IFSC });
});

/* ======================= it reads only the two names ==================== */

test("THE TWO NAMES ARE FOUND UNDER EITHER SPELLING THE PROVIDER USES", async () => {
  // Sandbox has published this payload with upper-case keys and with
  // snake_case. Guessing one and failing silently on the other is the failure
  // this tolerates - and the candidate list is configurable for the day it
  // changes again.
  const shapes = [
    { BANK: "State Bank of India", BRANCH: "Lawspet" },
    { bank: "State Bank of India", branch: "Lawspet" },
    { bank_name: "State Bank of India", branch_name: "Lawspet" },
    { BANK_NAME: "State Bank of India", BRANCH_NAME: "Lawspet" },
  ];
  for (const data of shapes) {
    const out = await new SandboxBankService(fakeClient(ok(data))).lookupIfsc(IFSC);
    assert.strictEqual(out.bank_name, "State Bank of India", JSON.stringify(data));
    assert.strictEqual(out.branch_name, "Lawspet", JSON.stringify(data));
  }
});

test("everything else in the payload is ignored", async () => {
  const client = fakeClient(
    ok({
      BANK: "State Bank of India",
      BRANCH: "Lawspet",
      CITY: "Puducherry",
      DISTRICT: "Puducherry",
      STATE: "Puducherry",
      ADDRESS: "100 Feet Road",
      MICR: "605002003",
      CONTACT: "9999999999",
      UPI: true,
      NEFT: true,
      RTGS: true,
      IMPS: true,
    })
  );
  const out = await new SandboxBankService(client).lookupIfsc(IFSC);
  assert.deepStrictEqual(Object.keys(out).sort(), ["bank_name", "branch_name", "exists", "ifsc"]);
});

test("a 200 carrying neither name is an unexpected response, not a valid IFSC", async () => {
  // Caching a blank would poison the master, and calling it invalid would be
  // a claim about the code we have no evidence for.
  for (const data of [{}, { BANK: "State Bank of India" }, { BRANCH: "Lawspet" }, { BANK: "  ", BRANCH: "  " }]) {
    await assert.rejects(
      () => new SandboxBankService(fakeClient(ok(data))).lookupIfsc(IFSC),
      (err) => {
        assert.ok(err instanceof SandboxError);
        assert.strictEqual(err.category, FAILURE.UNEXPECTED);
        return true;
      },
      JSON.stringify(data)
    );
  }
});

/* ======================= found, missing, broken ========================= */

test("A 404 IS AN ANSWER ABOUT THE CODE - EVERY OTHER FAILURE IS A FAULT", async () => {
  const notFound = fakeClient(() => {
    throw new SandboxError(FAILURE.NOT_FOUND, "no record", 502);
  });
  const out = await new SandboxBankService(notFound).lookupIfsc(IFSC);
  assert.deepStrictEqual(out, { exists: false, ifsc: IFSC, bank_name: null, branch_name: null });

  // Anything else propagates, so the usecase can keep "down" apart from "typo".
  for (const category of [FAILURE.UNAVAILABLE, FAILURE.TIMEOUT, FAILURE.AUTH_FAILED, FAILURE.RATE_LIMITED]) {
    const client = fakeClient(() => {
      throw new SandboxError(category, "safe", 502);
    });
    await assert.rejects(() => new SandboxBankService(client).lookupIfsc(IFSC), { category });
  }
});

/* ======================= validation before the call ===================== */

test("A MALFORMED IFSC NEVER REACHES THE PROVIDER", async () => {
  for (const bad of ["", "SBIN001050", "SBIN1010507", "  ", null, undefined]) {
    const client = fakeClient(ok({ BANK: "B", BRANCH: "Br" }));
    await assert.rejects(
      () => new SandboxBankService(client).lookupIfsc(bad),
      (err) => err instanceof SandboxError && err.httpCode === 422
    );
    assert.strictEqual(client.requests.length, 0, `${String(bad)} must not be sent`);
  }
});

test("normaliseIfsc is the IFSC half of the existing normalise, not a rewrite", () => {
  assert.strictEqual(SandboxBankService.normaliseIfsc(" sbin-0010507 "), IFSC);
  // The same rule the account+IFSC path applies to its IFSC.
  const both = SandboxBankService.normalise({ account_number: "123456", ifsc: "sbin 0010507" });
  assert.strictEqual(both.ifsc, SandboxBankService.normaliseIfsc("sbin 0010507"));
});

/* ======================= one authentication, not two ==================== */

test("IT REUSES THE SHARED CLIENT - NO SECOND AUTH OR TOKEN CACHE", () => {
  const src = fs.readFileSync(path.join(__dirname, "sandbox_bank.js"), "utf8");
  // Everything goes through `this.client.request`, which is what owns the
  // token, the single 401 retry, the timeout and the error mapping.
  assert.match(src, /await this\.client\.request\(\{[\s\S]{0,200}method: kycConfig\.bank\.ifscMethod/);
  for (const f of ["axios", "/authenticate", "getAccessToken", "x-api-key", "SANDBOX_API_SECRET", "Authorization"]) {
    assert.ok(!src.includes(f), `sandbox_bank.js must not do its own ${f}`);
  }
  // And it still has no logger of its own - the account number is in the
  // Penny-Less URL, and a module that cannot log cannot log it.
  assert.ok(!/require\(["'].*logger/.test(src));
});

test("the path and the response keys are configuration, not literals in code", () => {
  const src = fs.readFileSync(path.join(__dirname, "sandbox_bank.js"), "utf8");
  const lookup = src.slice(src.indexOf("async lookupIfsc"));
  assert.match(lookup, /kycConfig\.bank\.ifscPathTemplate/);
  assert.match(lookup, /kycConfig\.bank\.ifscMethod/);
  assert.ok(!/"\/bank\//.test(lookup), "no hard-coded path");

  assert.match(src, /kycConfig\.bank\.ifscBankNameKeys/);
  assert.match(src, /kycConfig\.bank\.ifscBranchNameKeys/);
  assert.deepStrictEqual(kycConfig.bank.ifscBankNameKeys, ["BANK", "bank", "bank_name", "BANK_NAME"]);
  assert.deepStrictEqual(kycConfig.bank.ifscBranchNameKeys, ["BRANCH", "branch", "branch_name", "BRANCH_NAME"]);
});
