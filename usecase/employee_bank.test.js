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
// Bank verification has its OWN secret. The Aadhaar values above are set only
// so the rest of the C2 modules load; nothing in this file depends on them,
// and one test proves that by running in a process where they are absent.
process.env.BANK_FINGERPRINT_KEY = "test-bank-fingerprint-key-at-least-32-chars";

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
    // Other employees who already hold a verification, so the duplicate check
    // has something real to find. Each is
    //   { employee_id, employee_name, active, account_no, ifsc, status }
    this.others = [];
  }

  /** Registers another employee already VERIFIED against an account. */
  addOther({ employee_id, employee_name = "Somebody Else", active = true, account_no, ifsc = IFSC, status = "VERIFIED" }) {
    this.others.push({ employee_id, employee_name, active, account_no, ifsc, status });
    return this;
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
  async findActiveDuplicates(fingerprint, exceptEmployeeId) {
    // Mirrors the real query: same fingerprint, a DIFFERENT employee, that
    // employee still active, and their verification actually VERIFIED.
    return store.others
      .filter(
        (o) =>
          o.active &&
          o.status === "VERIFIED" &&
          Number(o.employee_id) !== Number(exceptEmployeeId) &&
          EmployeeBankUsecase.fingerprint(o.account_no, o.ifsc) === fingerprint
      )
      .map((o) => ({
        employee_id: o.employee_id,
        employee_name: o.employee_name,
        status: o.status,
        account_last4: String(o.account_no).slice(-4),
        verified_on: "2026-01-01",
      }));
  },
  async overrideDuplicate(id, fingerprint, { actorEmployeeId, reason }) {
    const v = store.verification;
    if (!v || v.status !== STATUS.DUPLICATE_ACCOUNT || v.account_fingerprint !== fingerprint) return 0;
    Object.assign(v, {
      status: STATUS.VERIFIED,
      verified_at: new Date(),
      override_by_employee_id: actorEmployeeId,
      override_at: new Date(),
      override_reason: reason,
    });
    return 1;
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
  // The DISPLAY read, deliberately narrow - it does not carry the payload,
  // exactly as the real query does not.
  async getVerification() {
    return store.aadhaarName ? { verification_id: 1, status: "consumed" } : null;
  },
  async getVerificationDemographics() {
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
    // Every _log() call, bounded by matching its own parentheses. Slicing to
    // the next "});" was wrong: a call whose last argument is an object
    // literal closes with "\n);", so the slice ran on into the rest of the
    // file and asserted against code that was never logged.
    const extractCall = (tail) => {
      let depth = 1;
      for (let i = 0; i < tail.length; i++) {
        if (tail[i] === "(") depth += 1;
        else if (tail[i] === ")") {
          depth -= 1;
          if (depth === 0) return tail.slice(0, i);
        }
      }
      throw new Error("unbalanced _log( call in employee_bank.js");
    };
    const logCalls = src.split("this._log(").slice(1).map(extractCall);
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
      duplicate_of: null,
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

/* ====================================== duplicate bank accounts ========= */
describe("two active employees on one bank account", () => {
  const OTHER_EMP = 901;

  it("the second employee is detected and is NOT payroll ready", async () => {
    const { store, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, employee_name: "Priya Nair", account_no: ACCOUNT, ifsc: IFSC });

    const res = await uc.verify(EMP);
    assert.equal(res.status, STATUS.DUPLICATE_ACCOUNT);
    assert.equal(res.bank_payroll_ready, false);
    assert.equal((await uc.isBankPayrollReady(EMP)).bank_payroll_ready, false);
    assert.match((await uc.isBankPayrollReady(EMP)).reason, /another active employee/);
  });

  it("and the other employee is named, so HR can resolve it", async () => {
    const { store, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, employee_name: "Priya Nair", account_no: ACCOUNT, ifsc: IFSC });
    const res = await uc.verify(EMP);
    assert.equal(res.duplicate_of.length, 1);
    assert.equal(res.duplicate_of[0].employee_id, OTHER_EMP);
    assert.equal(res.duplicate_of[0].employee_name, "Priya Nair");
    assert.equal(res.requires_admin_override, true);
  });

  it("the response carries no account number and no fingerprint", async () => {
    const { store, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, account_no: ACCOUNT, ifsc: IFSC });
    const text = JSON.stringify(await uc.verify(EMP));
    assert.ok(!text.includes(ACCOUNT), "no full account number");
    assert.ok(!/fingerprint/i.test(text), "no fingerprint of any kind");
    // The last four is fine - it is the display value, and the caller already
    // sees it for their own employee.
    assert.ok(text.includes(ACCOUNT.slice(-4)));
  });

  it("neither employee's stored details are touched", async () => {
    const { store, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, account_no: ACCOUNT, ifsc: IFSC });
    const otherBefore = JSON.stringify(store.others);
    await uc.verify(EMP);
    assert.equal(JSON.stringify(store.others), otherBefore, "the other employee's row is not rewritten");
    assert.equal(store.employee.account_no, ACCOUNT, "and this employee keeps their own account");
  });

  it("a DIFFERENT account is unaffected - the normal case still works", async () => {
    const { store, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, account_no: OTHER_ACCOUNT, ifsc: IFSC });
    assert.equal((await uc.verify(EMP)).status, STATUS.VERIFIED);
  });

  it("an employee changing their OWN bank details is not a duplicate of themselves", async () => {
    const { store, uc } = build();
    assert.equal((await uc.verify(EMP)).status, STATUS.VERIFIED);
    // Same person, re-verifying the same account: the query excludes them.
    assert.equal((await uc.verify(EMP)).status, STATUS.VERIFIED);
    store.employee.account_no = OTHER_ACCOUNT;
    assert.equal((await uc.verify(EMP)).status, STATUS.VERIFIED);
  });

  it("an INACTIVE former employee on the same account does not block anyone", async () => {
    const { store, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, account_no: ACCOUNT, ifsc: IFSC, active: false });
    const res = await uc.verify(EMP);
    assert.equal(res.status, STATUS.VERIFIED, "a leaver's shared account is ordinary");
    assert.equal(res.bank_payroll_ready, true);
  });

  it("and a block lifts by itself when the other employee leaves - no paid call", async () => {
    const { store, provider, uc } = build();
    store.addOther({ employee_id: OTHER_EMP, account_no: ACCOUNT, ifsc: IFSC });
    assert.equal((await uc.verify(EMP)).status, STATUS.DUPLICATE_ACCOUNT);
    const callsSoFar = provider.calls.length;

    store.others[0].active = false; // they resign
    const after = await uc.getStatus(EMP);
    assert.equal(after.status, STATUS.VERIFIED, "the clash is over, and the bank's answer still stands");
    assert.equal(after.bank_payroll_ready, true);
    assert.equal(provider.calls.length, callsSoFar, "and it cost nothing to notice");
  });

  it("a name that never matched does not become VERIFIED when the clash lifts", async () => {
    const { store, provider, uc } = build();
    provider.nextResult = { account_exists: true, name_at_bank: "ACME TRADING", transaction_id: "T" };
    store.addOther({ employee_id: OTHER_EMP, account_no: ACCOUNT, ifsc: IFSC });
    // A MISMATCH never reaches the duplicate check at all.
    assert.equal((await uc.verify(EMP)).status, STATUS.NAME_MISMATCH);
    store.others[0].active = false;
    assert.equal((await uc.getStatus(EMP)).status, STATUS.NAME_MISMATCH);
  });
});

describe("the administrator override", () => {
  const OTHER_EMP = 901;
  const duplicated = async () => {
    const built = build();
    built.store.addOther({ employee_id: OTHER_EMP, employee_name: "Priya Nair", account_no: ACCOUNT, ifsc: IFSC });
    await built.uc.verify(EMP);
    return built;
  };

  it("makes a legitimate shared account payroll ready", async () => {
    const { uc } = await duplicated();
    const res = await uc.overrideDuplicate(EMP, { actorEmployeeId: 7, reason: "spouse's account, letter on file" });
    assert.equal(res.status, STATUS.VERIFIED);
    assert.equal(res.bank_payroll_ready, true);
  });

  it("is audited: who, when, and why - in the row and in the append-only log", async () => {
    const { store, uc } = await duplicated();
    await uc.overrideDuplicate(EMP, { actorEmployeeId: 7, reason: "spouse's account, letter on file" });

    assert.equal(store.verification.override_by_employee_id, 7);
    assert.equal(store.verification.override_reason, "spouse's account, letter on file");
    assert.ok(store.verification.override_at instanceof Date);

    const audit = store.attempts.filter((a) => a.outcome === "ADMIN_OVERRIDE");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].requested_by_employee_id, 7);
    assert.equal(audit[0].override_reason, "spouse's account, letter on file");
    assert.equal(audit[0].account_last4, ACCOUNT.slice(-4));
    assert.ok(!JSON.stringify(audit[0]).includes(ACCOUNT), "the audit row holds no account number");
  });

  it("refuses without a stated reason", async () => {
    const { uc } = await duplicated();
    for (const reason of [undefined, null, "", "   "]) {
      await assert.rejects(() => uc.overrideDuplicate(EMP, { actorEmployeeId: 7, reason }), /reason is required/);
    }
  });

  it("refuses when there is no duplicate to override", async () => {
    const { uc } = build();
    await uc.verify(EMP);
    await assert.rejects(
      () => uc.overrideDuplicate(EMP, { actorEmployeeId: 7, reason: "no" }),
      /is VERIFIED, not DUPLICATE_ACCOUNT/
    );
  });

  it("does not survive a re-verification - a new check is a new decision", async () => {
    const { store, uc } = await duplicated();
    await uc.overrideDuplicate(EMP, { actorEmployeeId: 7, reason: "spouse's account" });
    assert.equal((await uc.getStatus(EMP)).status, STATUS.VERIFIED);

    await uc.verify(EMP);
    assert.equal(store.verification.status, STATUS.DUPLICATE_ACCOUNT, "the clash is found again");
    assert.equal(store.verification.override_by_employee_id, null, "and the old override is cleared");
    // But the audit of the earlier override survives, because it is append-only.
    assert.equal(store.attempts.filter((a) => a.outcome === "ADMIN_OVERRIDE").length, 1);
  });
});

/* ============================= independence from Aadhaar ================ */
describe("bank verification does not depend on Aadhaar", () => {
  it("the module reads no Aadhaar configuration at all", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_bank.js"), "utf8");
    assert.ok(!/config\/aadhaar/.test(src), "employee_bank.js must not require config/aadhaar");
    assert.match(src, /config\/bank/, "it uses its own config");
    assert.match(src, /bankConfig\.fingerprintSecret/);
    assert.ok(!/AADHAAR_FINGERPRINT_KEY/.test(src), "and does not name the Aadhaar key");
  });

  it("the fingerprint is keyed on BANK_FINGERPRINT_KEY", () => {
    const withKey = EmployeeBankUsecase.fingerprint(ACCOUNT, IFSC);
    assert.match(withKey, /^[0-9a-f]{64}$/);
    // Domain-separated, and sensitive to both inputs.
    assert.notEqual(withKey, EmployeeBankUsecase.fingerprint(ACCOUNT, "ICIC0004321"));
    assert.notEqual(withKey, EmployeeBankUsecase.fingerprint(OTHER_ACCOUNT, IFSC));
  });

  it("a full verify runs in a process with NO Aadhaar configuration", () => {
    // A child process, because config/aadhaar is read at require time: this is
    // the only way to prove the claim rather than assert it about source text.
    const { execFileSync } = require("child_process");
    const script = `
      const path = ${JSON.stringify(__dirname)};
      const factory = require(path + "/employee_bank");
      const { EmployeeBankUsecase, STATUS } = factory;
      const { SandboxBankService } = require(path + "/../services/sandbox_bank");
      if (process.env.AADHAAR_FINGERPRINT_KEY || process.env.AADHAAR_ENCRYPTION_KEY) {
        throw new Error("this test must run without Aadhaar configuration");
      }
      const employee = { employee_id: 1, employee_name: "Ramesh Kumar", account_no: ${JSON.stringify(ACCOUNT)}, ifsc: ${JSON.stringify(IFSC)} };
      let stored = null;
      const repo = {
        getBankDetails: async () => ({ ...employee }),
        getVerification: async () => (stored ? { ...stored } : null),
        getStoredFingerprint: async () => (stored ? { account_fingerprint: stored.account_fingerprint, status: stored.status } : null),
        findActiveDuplicates: async () => [],
        upsertVerification: async (row) => { stored = { ...row }; return { affectedRows: 1 }; },
        recordAttempt: async () => ({ affectedRows: 1 }),
      };
      const provider = {
        isEnabled: () => true,
        constructor: SandboxBankService,
        pennyLessVerify: async () => ({ account_exists: true, name_at_bank: "RAMESH KUMAR", transaction_id: "T" }),
      };
      // NO aadhaarRepo at all - the third argument is omitted.
      const uc = factory(repo, provider);
      uc.verify(1).then((r) => {
        if (r.status !== STATUS.VERIFIED) throw new Error("expected VERIFIED, got " + r.status);
        if (!r.bank_payroll_ready) throw new Error("expected payroll ready");
        console.log("OK");
      }).catch((e) => { console.error(String(e && e.message)); process.exit(1); });
    `;
    const env = { ...process.env, BANK_FINGERPRINT_KEY: "test-bank-fingerprint-key-at-least-32-chars" };
    delete env.AADHAAR_FINGERPRINT_KEY;
    delete env.AADHAAR_ENCRYPTION_KEY;
    const out = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
    assert.match(out, /OK/);
  });

  it("but refuses clearly when its OWN key is missing or too short", () => {
    const { execFileSync } = require("child_process");
    const script = `
      const factory = require(${JSON.stringify(__dirname)} + "/employee_bank");
      try {
        factory.EmployeeBankUsecase.fingerprint("50100123456789", "HDFC0001234");
        console.log("NO ERROR");
      } catch (e) { console.log(e.message); }
    `;
    for (const value of ["", "too-short"]) {
      const env = { ...process.env, BANK_FINGERPRINT_KEY: value };
      const out = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
      assert.match(out, /BANK_FINGERPRINT_KEY/, `key ${JSON.stringify(value)} must be refused by name`);
      assert.ok(!out.includes(value) || value === "", "the refusal must not echo the key");
    }
  });
});
