/**
 * A VERIFICATION SESSION BELONGS TO EXACTLY ONE TARGET EMPLOYEE.
 *
 *   node --test usecase/employee_aadhaar_target_binding.test.js
 *
 * ============================== THE HOLE THIS CLOSES ======================
 *
 * The existing-employee flow bound a session to the ACTING USER
 * (`initiated_by_employee_id`) and to nothing else, so a direct API caller
 * holding `verify_employee_aadhaar` could initiate for employee A, complete
 * the OTP against employee B in the same branch, and attach A's Aadhaar to B.
 * Every other check passed: same caller, same branch, both PENDING. The UI
 * would not do it; authorization must not depend on the UI not doing it.
 *
 * ============================== AND WHAT MUST NOT CHANGE ==================
 *
 * Onboarding has no employee id at the time it verifies, so its sessions stay
 * unbound (`target_employee_id IS NULL`) and are consumed by Create Employee
 * exactly as before - as are every historical row and the "Skip for now,
 * attach later" sessions, which is why the attach rule is deliberately
 * asymmetric. Half this file is about that.
 *
 * NO REAL AADHAAR NUMBER APPEARS HERE: the numbers are computed to be valid
 * and are obviously synthetic.
 */
process.env.AADHAAR_ENCRYPTION_KEY = "0".repeat(63) + "1"; // 32 bytes, test only
process.env.AADHAAR_FINGERPRINT_KEY = "test-fingerprint-key-at-least-32-chars-long";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const aadhaarCrypto = require("../services/aadhaar_crypto");
const aadhaarUsecase = require("../usecase/employee_aadhaar");
const { EmployeeAadhaarUsecase } = aadhaarUsecase;
const logger = require("../utils/logger");

const withCheckDigit = (eleven) => {
  for (let d = 0; d <= 9; d++) {
    const candidate = eleven + String(d);
    if (aadhaarCrypto.verhoeffValid(candidate)) return candidate;
  }
  throw new Error("no valid check digit");
};
const AADHAAR_A = withCheckDigit("22222222222");
const AADHAAR_B = withCheckDigit("33333333333");
const OTP = "000000";

/** Two employees in the SAME branch, both PENDING - the attack's best case. */
const A = 301;
const B = 302;

/* ------------------------------------------------------------- the fake -- */

const makeStore = () => ({ verifications: [], identities: [], nextV: 1, nextI: 1 });

const makeRepo = (store) => ({
  async createVerification(row) {
    const id = store.nextV++;
    // The column is NULL unless the INSERT names it, which is what a
    // historical row and an onboarding row both look like.
    store.verifications.push({ verification_id: id, otp_attempts: 0, target_employee_id: null, ...row });
    return id;
  },
  async findVerificationByToken(token) {
    const v = store.verifications.find((x) => x.session_token === token);
    return v ? { ...v } : null;
  },
  async updateVerification(id, expectedStatus, patch) {
    const v = store.verifications.find((x) => x.verification_id === Number(id));
    if (!v || v.status !== expectedStatus) return 0;
    Object.assign(v, patch);
    return 1;
  },
  async incrementOtpAttempts(id) {
    const v = store.verifications.find((x) => x.verification_id === Number(id));
    if (!v) return 0;
    v.otp_attempts = Number(v.otp_attempts || 0) + 1;
    return 1;
  },
  async lockVerificationForUse(_tx, id) {
    const v = store.verifications.find((x) => x.verification_id === Number(id));
    return v ? { ...v } : null;
  },
  async consumeVerification(_tx, id, employeeId) {
    const v = store.verifications.find((x) => x.verification_id === Number(id));
    if (!v || v.status !== "verified") return 0;
    v.status = "consumed";
    v.employee_id = employeeId;
    v.aadhaar_ciphertext = null;
    return 1;
  },
  async findByFingerprint(fp) {
    const i = store.identities.find((x) => x.aadhaar_fingerprint === fp);
    return i ? { employee_id: i.employee_id, aadhaar_last4: i.aadhaar_last4, employee_status: 1 } : null;
  },
  async createIdentity(_tx, row) {
    if (store.identities.some((x) => x.employee_id === row.employee_id)) {
      throw new Error("uq_aadhaar_identity_employee");
    }
    const id = store.nextI++;
    store.identities.push({ aadhaar_identity_id: id, ...row });
    return id;
  },
  async getIdentity(employeeId) {
    return store.identities.find((x) => x.employee_id === Number(employeeId)) || null;
  },
  async getVerification(id) {
    return store.verifications.find((x) => x.verification_id === Number(id)) || null;
  },
  async getVerificationDemographics(id) {
    return store.verifications.find((x) => x.verification_id === Number(id)) || null;
  },
});

const makeProvider = () => {
  const calls = [];
  const provider = {
    calls,
    isEnabled: () => true,
    async generateOtp(number) {
      calls.push(["generateOtp", number]);
      return { reference_id: "REF-" + calls.length, transaction_id: "TXN-" + calls.length };
    },
    async verifyOtp(referenceId, otp) {
      calls.push(["verifyOtp", referenceId, otp]);
      return {
        transaction_id: "TXN-V",
        reference_id: referenceId,
        provider_status: "valid",
        demographics: { name: "Verified Person", date_of_birth: "01-02-1990", gender: "M" },
      };
    },
  };
  return provider;
};

const build = () => {
  const store = makeStore();
  const provider = makeProvider();
  return { store, provider, uc: aadhaarUsecase(makeRepo(store), provider) };
};

const row = (store, id) => store.verifications.find((v) => v.verification_id === Number(id));
const tokenOf = (store, id) => row(store, id).session_token;

/** Initiate for an existing employee, exactly as the route does. */
const initiateFor = (uc, target, number = AADHAAR_A) =>
  uc.initiate(
    { aadhaar_number: number, consent_given: true },
    { actorEmployeeId: 101, ip: "10.0.0.1", targetEmployeeId: target }
  );

/** Initiate through the ONBOARDING path, which names no employee. */
const initiateOnboarding = (uc, number = AADHAAR_B) =>
  uc.initiate({ aadhaar_number: number, consent_given: true }, { actorEmployeeId: 100 });

const refusal = async (fn, what) => {
  const err = await fn().then(
    () => null,
    (e) => e
  );
  assert.ok(err, `${what}: expected a refusal`);
  return err;
};

/* ===================================================================== */
/*  1-5. INITIATE AND OTP                                                */
/* ===================================================================== */

describe("the session is bound at initiation", () => {
  it("1. initiating for employee A stores A as the target", async () => {
    const { uc, store } = build();
    const started = await initiateFor(uc, A);
    const v = store.verifications.find((x) => x.session_token === started.verification_token);
    assert.equal(v.target_employee_id, A);
    // And the OTHER columns keep their existing meanings: the acting user is
    // still recorded, and `employee_id` - "consumed by" - is still empty.
    assert.equal(v.initiated_by_employee_id, 101);
    assert.ok(!v.employee_id, "a session that has not been consumed names no employee_id");
  });

  it("2. the OTP step against the SAME employee succeeds", async () => {
    const { uc, store } = build();
    const started = await initiateFor(uc, A);
    const res = await uc.verifyOtp(
      { verification_token: started.verification_token, otp: OTP },
      { actorEmployeeId: 101, targetEmployeeId: A }
    );
    assert.equal(res.code, 200);
    assert.equal(row(store, res.verification_id).status, "verified");
  });

  it("3. the OTP step against employee B - same branch, same caller - is refused", async () => {
    const { uc } = build();
    const started = await initiateFor(uc, A);
    const err = await refusal(
      () =>
        uc.verifyOtp(
          { verification_token: started.verification_token, otp: OTP },
          { actorEmployeeId: 101, targetEmployeeId: B }
        ),
      "A's token aimed at B"
    );
    assert.equal(err.httpCode, 409, "a generic conflict, not a 404 that maps the estate");
    // It names nobody and nothing: not A, not B, not a branch, not a name.
    for (const leak of [String(A), String(B), "branch", "belongs to", "another"]) {
      assert.ok(
        !err.message.toLowerCase().includes(leak.toLowerCase()),
        `the refusal must not mention "${leak}"`
      );
    }
  });

  it("4. a wrong-target OTP never reaches the provider", async () => {
    const { uc, provider } = build();
    const started = await initiateFor(uc, A);
    const before = provider.calls.length;
    await refusal(
      () =>
        uc.verifyOtp(
          { verification_token: started.verification_token, otp: OTP },
          { actorEmployeeId: 101, targetEmployeeId: B }
        ),
      "wrong target"
    );
    assert.equal(provider.calls.length, before, "no provider call was made");
    assert.ok(!provider.calls.some(([m]) => m === "verifyOtp"), "and certainly not verifyOtp");
  });

  it("5. a wrong-target OTP never spends an attempt, and never closes the session", async () => {
    const { uc, store } = build();
    const started = await initiateFor(uc, A);
    const v = store.verifications.find((x) => x.session_token === started.verification_token);
    assert.equal(v.otp_attempts, 0);

    for (let i = 0; i < 6; i += 1) {
      await refusal(
        () =>
          uc.verifyOtp(
            { verification_token: started.verification_token, otp: OTP },
            { actorEmployeeId: 101, targetEmployeeId: B }
          ),
        "wrong target"
      );
    }
    // Six wrong-target attempts would have exhausted the five-attempt budget
    // if they counted - which is the second half of the attack: exhaust A's
    // verification by aiming it at B.
    assert.equal(v.otp_attempts, 0, "no attempt is spent on a session that was not aimed here");
    assert.equal(v.status, "initiated", "and the session is not failed or expired");

    // A's own verification still works afterwards.
    const res = await uc.verifyOtp(
      { verification_token: started.verification_token, otp: OTP },
      { actorEmployeeId: 101, targetEmployeeId: A }
    );
    assert.equal(res.code, 200);
  });
});

/* ===================================================================== */
/*  6-8. ATTACH - THE FINAL ENFORCEMENT                                  */
/* ===================================================================== */

describe("only the target employee may consume the session", () => {
  const verifiedFor = async (uc, target) => {
    const started = await initiateFor(uc, target);
    return uc.verifyOtp(
      { verification_token: started.verification_token, otp: OTP },
      { actorEmployeeId: 101, targetEmployeeId: target }
    );
  };

  it("6. initiate A -> verify A -> attach A succeeds", async () => {
    const { uc, store } = build();
    const decision = await verifiedFor(uc, A);
    const attached = await uc.attachToEmployee({}, decision.verification_id, A, { actorEmployeeId: 101 });
    assert.ok(attached.aadhaar_last4);
    assert.equal(row(store, decision.verification_id).status, "consumed");
    assert.equal(store.identities[0].employee_id, A);
  });

  it("7. initiate A -> verify A -> attach B is refused, and nothing is written", async () => {
    const { uc, store } = build();
    const decision = await verifiedFor(uc, A);
    const err = await refusal(
      () => uc.attachToEmployee({}, decision.verification_id, B, { actorEmployeeId: 101 }),
      "attaching A's verification to B"
    );
    assert.equal(err.httpCode, 409);
    assert.equal(store.identities.length, 0, "no identity row was created");
    assert.equal(row(store, decision.verification_id).status, "verified", "the session is untouched");
    // And A can still complete their own attach afterwards.
    await uc.attachToEmployee({}, decision.verification_id, A, { actorEmployeeId: 101 });
    assert.equal(store.identities[0].employee_id, A);
  });

  it("8. the enforcement is in the USECASE, so bypassing the route does not help", async () => {
    // This test deliberately calls the usecase directly - no Express, no
    // permission middleware, no branch scope, no route parameter. A caller who
    // reached this function by any means at all is still refused.
    const { uc } = build();
    const decision = await verifiedFor(uc, A);
    const err = await refusal(
      () => uc.attachToEmployee({}, decision.verification_id, B, {}),
      "direct usecase call"
    );
    assert.equal(err.httpCode, 409);

    // And the rule itself is one pure function, so it cannot drift between
    // the two places that ask it.
    assert.equal(typeof EmployeeAadhaarUsecase.assertTargetMatches, "function");
    assert.throws(() => EmployeeAadhaarUsecase.assertTargetMatches(A, B), /cannot be used/);
    assert.throws(() => EmployeeAadhaarUsecase.assertTargetMatches(A, null), /cannot be used/);
    assert.throws(() => EmployeeAadhaarUsecase.assertTargetMatches(null, A), /cannot be used/);
    EmployeeAadhaarUsecase.assertTargetMatches(A, A);
    EmployeeAadhaarUsecase.assertTargetMatches(null, null);
    EmployeeAadhaarUsecase.assertTargetMatches(undefined, undefined);
    // String and number forms of the same id are the same employee: the route
    // parameter arrives as text and the column as a number.
    EmployeeAadhaarUsecase.assertTargetMatches(A, String(A));
  });
});

/* ===================================================================== */
/*  12-15. ONBOARDING IS UNCHANGED                                       */
/* ===================================================================== */

describe("onboarding keeps its unbound semantics", () => {
  it("12. onboarding initiate creates an UNBOUND session", async () => {
    const { uc, store } = build();
    const started = await initiateOnboarding(uc);
    const v = store.verifications.find((x) => x.session_token === started.verification_token);
    assert.equal(v.target_employee_id, null, "there is no employee yet to bind to");
  });

  it("13. onboarding OTP verification still works", async () => {
    const { uc, provider } = build();
    const started = await initiateOnboarding(uc);
    const res = await uc.verifyOtp(
      { verification_token: started.verification_token, otp: OTP },
      { actorEmployeeId: 100 }
    );
    assert.equal(res.code, 200);
    assert.equal(res.next_action, "create");
    assert.ok(provider.calls.some(([m]) => m === "verifyOtp"), "the provider was reached");
  });

  it("14. Create Employee can still consume a NULL-target verification", async () => {
    const { uc, store } = build();
    const started = await initiateOnboarding(uc);
    const decision = await uc.verifyOtp(
      { verification_token: started.verification_token, otp: OTP },
      { actorEmployeeId: 100 }
    );
    // The employee_id is invented by the create, and was never on the session.
    const attached = await uc.attachToEmployee({}, decision.verification_id, 900, { actorEmployeeId: 100 });
    assert.ok(attached.aadhaar_last4);
    assert.equal(store.identities[0].employee_id, 900);
    assert.equal(row(store, decision.verification_id).status, "consumed");
  });

  it("15. a HISTORICAL row with no target column at all behaves as onboarding", async () => {
    // What every pre-migration row looks like when it is read back: the key is
    // simply absent, not null. It must not be mistaken for a bound session.
    const { uc, store } = build();
    const started = await initiateOnboarding(uc);
    const v = store.verifications.find((x) => x.session_token === started.verification_token);
    delete v.target_employee_id;

    const decision = await uc.verifyOtp(
      { verification_token: started.verification_token, otp: OTP },
      { actorEmployeeId: 100 }
    );
    assert.equal(decision.code, 200);
    delete row(store, decision.verification_id).target_employee_id;
    const attached = await uc.attachToEmployee({}, decision.verification_id, 901, { actorEmployeeId: 100 });
    assert.ok(attached.aadhaar_last4, "a historical session still attaches during a create");

    // But an UNBOUND session may not be driven through the BOUND path either:
    // that is how a flow would enter the existing-employee route without ever
    // having been bound.
    const other = await initiateOnboarding(uc, AADHAAR_A);
    await refusal(
      () =>
        uc.verifyOtp(
          { verification_token: other.verification_token, otp: OTP },
          { actorEmployeeId: 101, targetEmployeeId: A }
        ),
      "an unbound session on the bound path"
    );
  });
});

/* ===================================================================== */
/*  16. NOTHING SECRET IS LOGGED                                         */
/* ===================================================================== */

describe("logging", () => {
  it("16. no full Aadhaar number and no OTP is logged, on success or refusal", async () => {
    const written = [];
    const original = logger.Log;
    logger.Log = (entry) => {
      written.push(JSON.stringify(entry));
    };
    try {
      const { uc } = build();
      const started = await initiateFor(uc, A);
      await refusal(
        () =>
          uc.verifyOtp(
            { verification_token: started.verification_token, otp: OTP },
            { actorEmployeeId: 101, targetEmployeeId: B }
          ),
        "wrong target"
      );
      const decision = await uc.verifyOtp(
        { verification_token: started.verification_token, otp: OTP },
        { actorEmployeeId: 101, targetEmployeeId: A }
      );
      await refusal(
        () => uc.attachToEmployee({}, decision.verification_id, B, { actorEmployeeId: 101 }),
        "attach mismatch"
      );
      await uc.attachToEmployee({}, decision.verification_id, A, { actorEmployeeId: 101 });
    } finally {
      logger.Log = original;
    }
    const all = written.join("\n");
    assert.ok(written.length > 0, "the flow does log - so the assertion below means something");
    for (const secret of [AADHAAR_A, AADHAAR_B, OTP, "ciphertext", "fingerprint"]) {
      assert.ok(!all.includes(secret), `${secret} must never be logged`);
    }
  });
});
