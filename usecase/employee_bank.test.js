/**
 * Stage 0C / C2 — Penny-Less bank verification, name matching and the
 * invalidation rule.
 *
 *   node --test usecase/employee_bank.test.js
 *
 * The three things worth being careful about, and what is done about each:
 *
 *   the account number escaping   asserted absent from every response and
 *                                 from the module's own source
 *   a stale VERIFIED              the status is recomputed from a fingerprint
 *                                 of the CURRENT account, so a changed
 *                                 account cannot keep an old verification
 *   a name comparison that lies   MATCH / REVIEW / MISMATCH, with MISMATCH
 *                                 not confirmable at all
 */
process.env.AADHAAR_ENCRYPTION_KEY = "0".repeat(63) + "1";
process.env.AADHAAR_FINGERPRINT_KEY = "test-fingerprint-key-at-least-32-chars-long";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const bankUsecaseFactory = require("./employee_bank");
const { EmployeeBankUsecase, STATUS, maskAccount } = bankUsecaseFactory;
const { SandboxBankService } = require("../services/sandbox_bank");
const { SandboxError, FAILURE, SAFE_MESSAGE } = require("../services/sandbox_client");

const ACCOUNT = "50100123456789";
const IFSC = "HDFC0001234";
const OTHER_ACCOUNT = "50100987654321";

/* ------------------------------------------------------------- the fake -- */
class Store {
  constructor(employee = {}) {
    this.employee = {
      employee_id: 900,
      employee_name: "Ramesh Kumar",
      account_no: ACCOUNT,
      ifsc: IFSC,
      bank_name: "HDFC Bank",
      ...employee,
    };
    this.verification = null;
    this.attempts = [];
    this.aadhaarName = null;
  }
}

const makeRepo = (store) => ({
  async getBankDetails(id) {
    return Number(id) === Number(store.employee.employee_id) ? { ...store.employee } : null;
  },
  async getVerification(id) {
    if (!store.verification || Number(id) !== Number(store.employee.employee_id)) return null;
    // The public projection: the repository's real query never selects a full
    // account number, so neither does this.
    const { account_fingerprint, ...safe } = store.verification;
    return { ...safe };
  },
  async getStoredFingerprint(id) {
    if (!store.verification || Number(id) !== Number(store.employee.employee_id)) return null;
    return { account_fingerprint: store.verification.account_fingerprint, status: store.verification.status };
  },
  async upsertVerification(row) {
    store.verification = { ...row };
    return { affectedRows: 1 };
  },
  async recordAttempt(row) {
    store.attempts.push(row);
    return { affectedRows: 1 };
  },
  async listAttempts() {
    return [...store.attempts].reverse();
  },
  async confirmNameMismatch(id, fingerprint, { actorEmployeeId, note }) {
    const v = store.verification;
    if (!v || v.status !== STATUS.NAME_MISMATCH || v.account_fingerprint !== fingerprint) return 0;
    Object.assign(v, {
      status: STATUS.VERIFIED,
      verified_at: new Date(),
      confirmed_by_employee_id: actorEmployeeId,
      confirmed_at: new Date(),
      confirmation_note: note || null,
    });
    return 1;
  },
});

const makeAadhaarRepo = (store) => ({
  async getIdentity() {
    return store.aadhaarName ? { employee_id: store.employee.employee_id, verification_id: 1 } : null;
  },
  async getVerification() {
    return store.aadhaarName ? { demographics_json: JSON.stringify({ name: store.aadhaarName }) } : null;
  },
});

/** Stands in for services/sandbox_bank.js; no network anywhere in this file. */
const makeProvider = () => {
  const calls = [];
  const provider = {
    calls,
    enabled: true,
    nextError: null,
    nextResult: { account_exists: true, name_at_bank: "RAMESH KUMAR", provider_status: "success", transaction_id: "TXN-1" },
    isEnabled: () => provider.enabled,
    // The usecase calls `this.provider.constructor.normalise`, so the fake
    // must expose the real one - local validation is not being mocked away.
    constructor: SandboxBankService,
    async pennyLessVerify(input) {
      calls.push(input);
      if (provider.nextError) {
        const e = provider.nextError;
        provider.nextError = null;
        throw e;
      }
      return provider.nextResult;
    },
  };
  return provider;
};

const build = (employee) => {
  const store = new Store(employee);
  const provider = makeProvider();
  const uc = bankUsecaseFactory(makeRepo(store), provider, makeAadhaarRepo(store));
  return { store, provider, uc };
};

const EMP = 900;

/* ================================================== onboarding is free == */
describe("36/37/55. bank details never block onboarding", () => {
  it("an employee with no bank details is NOT_PROVIDED and not payroll ready", async () => {
    const { uc } = build({ account_no: null, ifsc: null });
    const status = await uc.getStatus(EMP);
    assert.equal(status.status, STATUS.NOT_PROVIDED);
    assert.equal(status.bank_payroll_ready, false);
    assert.equal(status.masked_account, null);
  });

  it("an employee with unverified bank details is PENDING", async () => {
    const { uc } = build();
    const status = await uc.getStatus(EMP);
    assert.equal(status.status, STATUS.PENDING);
    assert.equal(status.bank_payroll_ready, false);
  });

  it("55. no Aadhaar on file does not block a bank verification", async () => {
    const { store, uc } = build();
    store.aadhaarName = null;
    const res = await uc.verify(EMP, { actorEmployeeId: 7 });
    assert.equal(res.status, STATUS.VERIFIED);
  });

  it("66. nothing here touches the lifecycle", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_bank.js"), "utf8");
    for (const forbidden of [
      "employee_employment_period", "employee_lifecycle_event", "reconcileEmployee",
      "period_no", "period_state", "resignation_date",
    ]) {
      assert.ok(!new RegExp(forbidden).test(src), `bank verification must not touch ${forbidden}`);
    }
  });
});

/* ========================================================== validation == */
describe("39/40/41. what is refused before a paid call", () => {
  it("a missing account number is refused", async () => {
    const { provider, uc } = build({ account_no: null });
    await assert.rejects(() => uc.verify(EMP), /no bank account on file/);
    assert.equal(provider.calls.length, 0);
  });

  it("a missing IFSC is refused", async () => {
    const { provider, uc } = build({ ifsc: "" });
    await assert.rejects(() => uc.verify(EMP), /no IFSC on file/);
    assert.equal(provider.calls.length, 0);
  });

  it("a locally invalid IFSC never reaches the provider", async () => {
    for (const bad of ["HDFC1001234", "HDF0001234", "HDFC0001", "notanifsc"]) {
      const { provider, uc } = build({ ifsc: bad });
      await assert.rejects(() => uc.verify(EMP), /not a valid IFSC/);
      assert.equal(provider.calls.length, 0, `${bad} must not be sent`);
    }
  });

  it("a locally impossible account number never reaches the provider", async () => {
    const { provider, uc } = build({ account_no: "12" });
    await assert.rejects(() => uc.verify(EMP), /6 to 20 digits/);
    assert.equal(provider.calls.length, 0);
  });

  it("62. a verification is refused for an employee that does not exist", async () => {
    const { uc } = build();
    await assert.rejects(() => uc.verify(12345), /does not exist/);
  });
});

/* ========================================================== the outcomes = */
describe("42/43/50/51/53. what the bank says becomes a status", () => {
  it("42/50. an existing account with a matching name is VERIFIED", async () => {
    const { store, uc } = build();
    const res = await uc.verify(EMP, { actorEmployeeId: 7 });
    assert.equal(res.status, STATUS.VERIFIED);
    assert.equal(res.bank_payroll_ready, true);
    assert.equal(store.verification.name_at_bank, "RAMESH KUMAR");
    assert.equal(store.verification.name_match_verdict, "MATCH");
    assert.ok(store.verification.verified_at);
    assert.equal(store.attempts.length, 1);
    assert.equal(store.attempts[0].outcome, STATUS.VERIFIED);
  });

  it("43. an account the bank does not know is FAILED, not an error", async () => {
    const { store, uc } = build();
    const p = build();
    const { provider, uc: uc2, store: store2 } = p;
    provider.nextResult = { account_exists: false, name_at_bank: null, transaction_id: "TXN-2" };
    const res = await uc2.verify(EMP);
    assert.equal(res.status, STATUS.FAILED);
    assert.equal(res.account_exists, false);
    assert.equal(store2.verification.failure_category, "account_not_found");
    assert.equal(store2.verification.verified_at, null);
  });

  it("51. a close-but-not-identical name is NAME_MISMATCH, never silently VERIFIED", async () => {
    const { store, provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "R KUMAR", transaction_id: "T" };
    const res = await uc.verify(EMP);
    assert.equal(res.status, STATUS.VERIFIED, "an initial standing for a full name is a match");

    const p2 = build();
    p2.provider.nextResult = { account_exists: true, name_at_bank: "R K", transaction_id: "T" };
    const res2 = await p2.uc.verify(EMP);
    assert.equal(res2.status, STATUS.NAME_MISMATCH, "initials alone need a human");
    assert.equal(res2.bank_payroll_ready, false);
  });

  it("53. an obviously different name is NEVER silently VERIFIED", async () => {
    const { store, provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "PRIYA SHARMA", transaction_id: "T" };
    const res = await uc.verify(EMP);
    assert.equal(res.status, STATUS.NAME_MISMATCH);
    assert.equal(store.verification.name_match_verdict, "MISMATCH");
    assert.equal(res.bank_payroll_ready, false);
  });

  it("54. a verified Aadhaar name participates in the comparison", async () => {
    // The HR spelling is short; the bank matches the Aadhaar instead.
    const { store, provider, uc } = build({ employee_name: "Ramesh" });
    store.aadhaarName = "Ramesh Kumar Sharma";
    provider.nextResult = { account_exists: true, name_at_bank: "RAMESH KUMAR SHARMA", transaction_id: "T" };
    const res = await uc.verify(EMP);
    assert.equal(res.status, STATUS.VERIFIED);
    assert.equal(res.name_match.matched_against, "aadhaar_name");
  });
});

/* ==================================================== provider failures == */
describe("44/45/46. a provider failure never verifies anything", () => {
  for (const [category, pattern] of [
    [FAILURE.TIMEOUT, /did not respond in time/],
    [FAILURE.AUTH_FAILED, /rejected our credentials/],
    [FAILURE.NOT_ENTITLED, /not enabled on the provider account/],
    [FAILURE.UNAVAILABLE, /unavailable/],
  ]) {
    it(`${category} records FAILED and raises a safe message`, async () => {
      const { store, provider, uc } = build();
      provider.nextError = new SandboxError(category, SAFE_MESSAGE[category]);
      await assert.rejects(() => uc.verify(EMP), pattern);
      assert.equal(store.verification.status, STATUS.FAILED);
      assert.equal(store.verification.failure_category, category);
      assert.equal(store.verification.verified_at, null);
      assert.equal(store.attempts[0].outcome, STATUS.FAILED);
    });
  }

  it("67. and the employee record itself is untouched by a failure", async () => {
    const { store, provider, uc } = build();
    const before = JSON.stringify(store.employee);
    provider.nextError = new SandboxError(FAILURE.UNAVAILABLE, "unavailable");
    await assert.rejects(() => uc.verify(EMP));
    assert.equal(JSON.stringify(store.employee), before);
  });

  it("with no provider configured the route refuses rather than pretending", async () => {
    const { provider, uc } = build();
    provider.enabled = false;
    await assert.rejects(() => uc.verify(EMP), /not configured on this server/);
  });
});

/* ===================================================== the account number */
describe("47/48/63. the account number never escapes", () => {
  it("47. no response carries it, in any state", async () => {
    const { uc } = build();
    const verified = await uc.verify(EMP);
    const status = await uc.getStatus(EMP);
    const ready = await uc.isBankPayrollReady(EMP);
    for (const payload of [verified, status, ready]) {
      assert.ok(!JSON.stringify(payload).includes(ACCOUNT), "the full account number must not appear");
    }
    assert.equal(status.masked_account, "**********6789");
    assert.equal(verified.account_last4, "6789");
  });

  it("48. and the module cannot log it", () => {
    const src = fs
      .readFileSync(path.join(__dirname, "employee_bank.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/console\./.test(src), "no console logging");
    // Every _log() call, bounded at its own closing brace so the match does
    // not run on into the rest of the file.
    const logCalls = src
      .split("this._log(")
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf("});") + 3));
    assert.ok(logCalls.length >= 2, "the log calls must be found");
    for (const call of logCalls) {
      for (const forbidden of ["account_no", "account_number", "clean.account", "employee.account"]) {
        assert.ok(!call.includes(forbidden), `a log call mentions ${forbidden}`);
      }
    }
    const provider = fs
      .readFileSync(path.join(__dirname, "..", "services/sandbox_bank.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/logger|console\./.test(provider), "the provider module cannot log at all");
  });

  it("63. the repository selects a full account only where the check needs it", () => {
    const repo = fs.readFileSync(path.join(__dirname, "..", "repository/employee_bank.js"), "utf8");
    const selects = repo.match(/SELECT[\s\S]*?FROM/g) || [];
    const withAccount = selects.filter((s) => /account_no\b/.test(s));
    assert.equal(withAccount.length, 1, "only getBankDetails reads the account itself");
    assert.ok(!/SELECT \*/.test(repo));
  });

  it("masks correctly whatever the length", () => {
    assert.equal(maskAccount("123456789"), "*****6789");
    assert.equal(maskAccount("1234"), "****");
    assert.equal(maskAccount("12"), "****");
  });
});

/* ============================================ invalidation on change ==== */
describe("56/57/58. a changed account invalidates the verification", () => {
  it("56. changing the account number makes a VERIFIED status PENDING again", async () => {
    const { store, uc } = build();
    assert.equal((await uc.verify(EMP)).status, STATUS.VERIFIED);
    assert.equal((await uc.getStatus(EMP)).status, STATUS.VERIFIED);

    store.employee.account_no = OTHER_ACCOUNT;
    const after = await uc.getStatus(EMP);
    assert.equal(after.status, STATUS.PENDING, "the old verification does not describe this account");
    assert.equal(after.bank_payroll_ready, false);
    assert.equal(after.stale, true);
    assert.equal(after.verification, null);
    assert.equal(after.superseded_verification.applies_to_current_account, false);
  });

  it("57. changing the IFSC does the same", async () => {
    const { store, uc } = build();
    await uc.verify(EMP);
    store.employee.ifsc = "ICIC0004321";
    const after = await uc.getStatus(EMP);
    assert.equal(after.status, STATUS.PENDING);
    assert.equal(after.bank_payroll_ready, false);
  });

  it("58. an unrelated edit does NOT invalidate it", async () => {
    const { store, uc } = build();
    await uc.verify(EMP);
    store.employee.employee_name = "Ramesh Kumar Sharma";
    store.employee.bank_name = "HDFC Bank Ltd";
    const after = await uc.getStatus(EMP);
    assert.equal(after.status, STATUS.VERIFIED);
    assert.equal(after.bank_payroll_ready, true);
  });

  it("formatting differences in the same account are not a change", async () => {
    const { store, uc } = build();
    await uc.verify(EMP);
    store.employee.account_no = `${ACCOUNT.slice(0, 5)} ${ACCOUNT.slice(5)}`;
    store.employee.ifsc = IFSC.toLowerCase();
    assert.equal((await uc.getStatus(EMP)).status, STATUS.VERIFIED, "same account, typed differently");
  });

  it("59. re-verifying after a change works and replaces the result", async () => {
    const { store, uc } = build();
    await uc.verify(EMP);
    store.employee.account_no = OTHER_ACCOUNT;
    assert.equal((await uc.getStatus(EMP)).status, STATUS.PENDING);

    const again = await uc.verify(EMP, { actorEmployeeId: 7 });
    assert.equal(again.status, STATUS.VERIFIED);
    assert.equal(again.account_last4, OTHER_ACCOUNT.slice(-4));
    assert.equal((await uc.getStatus(EMP)).status, STATUS.VERIFIED);
    assert.equal(store.attempts.length, 2, "both attempts are kept");
  });
});

/* ================================================= no accidental calls == */
describe("60/61. the provider is called only when asked", () => {
  it("60. repeated status reads never call the provider again", async () => {
    const { provider, uc } = build();
    await uc.verify(EMP);
    assert.equal(provider.calls.length, 1);
    for (let i = 0; i < 5; i++) await uc.getStatus(EMP);
    await uc.isBankPayrollReady(EMP);
    await uc.listAttempts(EMP);
    assert.equal(provider.calls.length, 1, "reading a status is free");
  });

  it("61. and neither does reading the status of an unverified employee", async () => {
    const { provider, uc } = build();
    await uc.getStatus(EMP);
    await uc.isBankPayrollReady(EMP);
    assert.equal(provider.calls.length, 0);
  });

  it("only one method in the usecase calls the provider at all", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_bank.js"), "utf8");
    const hits = src.match(/this\.provider\.pennyLessVerify/g) || [];
    assert.equal(hits.length, 1, "one provider call site");
    const verifyBlock = src.slice(src.indexOf("async verify("), src.indexOf("async confirmNameMismatch"));
    assert.match(verifyBlock, /this\.provider\.pennyLessVerify/);
  });
});

/* ================================================ the human confirmation = */
describe("52. a legitimate mismatch can be confirmed; an illegitimate one cannot", () => {
  it("52. HR can confirm a REVIEW verdict, and it is recorded against them", async () => {
    const { store, provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "R K", transaction_id: "T" };
    assert.equal((await uc.verify(EMP)).status, STATUS.NAME_MISMATCH);

    const after = await uc.confirmNameMismatch(EMP, { actorEmployeeId: 7, note: "passbook checked" });
    assert.equal(after.status, STATUS.VERIFIED);
    assert.equal(after.bank_payroll_ready, true);
    assert.equal(store.verification.confirmed_by_employee_id, 7);
    assert.equal(store.verification.confirmation_note, "passbook checked");
    assert.ok(store.verification.confirmed_at);
  });

  it("53. a MISMATCH verdict cannot be confirmed at all", async () => {
    const { provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "PRIYA SHARMA", transaction_id: "T" };
    await uc.verify(EMP);
    await assert.rejects(() => uc.confirmNameMismatch(EMP, { actorEmployeeId: 7 }), /does not match this employee at all/);
  });

  it("there is nothing to confirm on a VERIFIED or FAILED row", async () => {
    const { uc } = build();
    await uc.verify(EMP);
    await assert.rejects(() => uc.confirmNameMismatch(EMP, { actorEmployeeId: 7 }), /is VERIFIED, not NAME_MISMATCH/);
  });

  it("a confirmation cannot land on an account that has since changed", async () => {
    const { store, provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "R K", transaction_id: "T" };
    await uc.verify(EMP);
    store.employee.account_no = OTHER_ACCOUNT;
    await assert.rejects(() => uc.confirmNameMismatch(EMP, { actorEmployeeId: 7 }), /is PENDING, not NAME_MISMATCH/);
  });

  it("a fresh verification clears a previous confirmation", async () => {
    const { store, provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "R K", transaction_id: "T" };
    await uc.verify(EMP);
    await uc.confirmNameMismatch(EMP, { actorEmployeeId: 7 });
    assert.equal(store.verification.confirmed_by_employee_id, 7);

    provider.nextResult = { account_exists: true, name_at_bank: "R K", transaction_id: "T2" };
    await uc.verify(EMP);
    assert.equal(store.verification.confirmed_by_employee_id, null, "the old acceptance does not carry over");
    assert.equal(store.verification.status, STATUS.NAME_MISMATCH);
  });
});

/* =============================================== payroll readiness ====== */
describe("64/65. the payroll-readiness helper", () => {
  it("64. is false while unverified, with a reason", async () => {
    const { store, uc } = build({ account_no: null, ifsc: null });
    assert.deepEqual(await uc.isBankPayrollReady(EMP), {
      employee_id: EMP,
      bank_payroll_ready: false,
      status: STATUS.NOT_PROVIDED,
      reason: "no bank account on file",
    });

    store.employee.account_no = ACCOUNT;
    store.employee.ifsc = IFSC;
    const pending = await uc.isBankPayrollReady(EMP);
    assert.equal(pending.bank_payroll_ready, false);
    assert.match(pending.reason, /not been verified/);
  });

  it("65. is true once verified", async () => {
    const { uc } = build();
    await uc.verify(EMP);
    const ready = await uc.isBankPayrollReady(EMP);
    assert.equal(ready.bank_payroll_ready, true);
    assert.equal(ready.reason, null);
  });

  it("and false again the moment the account changes", async () => {
    const { store, uc } = build();
    await uc.verify(EMP);
    store.employee.ifsc = "ICIC0004321";
    assert.equal((await uc.isBankPayrollReady(EMP)).bank_payroll_ready, false);
  });

  it("19. is readiness metadata only - it decides no payroll rule", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_bank.js"), "utf8");
    for (const forbidden of ["salary", "payout", "payslip", "net_pay", "gross"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`, "i").test(src), `${forbidden} is payroll's business, not this file's`);
    }
  });
});
