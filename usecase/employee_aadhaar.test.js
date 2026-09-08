/**
 * Stage 0C / C2 — Aadhaar verification, storage and duplicate detection.
 *
 *   node --test usecase/employee_aadhaar.test.js
 *
 * The two things that matter most here are that the number never escapes,
 * and that the same person can never become two employees. Both are tested
 * by looking for the number in places it must not be, and by driving the
 * duplicate path end to end.
 */
process.env.AADHAAR_ENCRYPTION_KEY = "0".repeat(63) + "1"; // 32 bytes, test only
process.env.AADHAAR_FINGERPRINT_KEY = "test-fingerprint-key-at-least-32-chars-long";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const aadhaarCrypto = require("../services/aadhaar_crypto");
const aadhaarConfig = require("../config/aadhaar");
const aadhaarUsecase = require("../usecase/employee_aadhaar");
const { EmployeeAadhaarUsecase } = aadhaarUsecase;

/**
 * Valid test numbers: twelve digits, not starting 0 or 1, correct Verhoeff
 * check digit. Computed rather than copied, so they are certainly valid and
 * certainly not anybody's.
 */
const withCheckDigit = (eleven) => {
  for (let d = 0; d <= 9; d++) {
    const candidate = eleven + String(d);
    if (aadhaarCrypto.verhoeffValid(candidate)) return candidate;
  }
  throw new Error("no valid check digit");
};
const AADHAAR_A = withCheckDigit("22222222222");
const AADHAAR_B = withCheckDigit("33333333333");

/* ------------------------------------------------------------- the fake -- */
class Store {
  constructor() {
    this.verifications = [];
    this.identities = [];
    this.nextVerification = 1;
    this.nextIdentity = 1;
  }
}

const makeRepo = (store) => ({
  async createVerification(row) {
    const id = store.nextVerification++;
    store.verifications.push({ verification_id: id, ...row });
    return id;
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
    v.aadhaar_iv = null;
    v.aadhaar_auth_tag = null;
    return 1;
  },
  async getVerification(id) {
    const v = store.verifications.find((x) => x.verification_id === Number(id));
    if (!v) return null;
    const { aadhaar_ciphertext, aadhaar_iv, aadhaar_auth_tag, aadhaar_fingerprint, ...safe } = v;
    return safe;
  },
  async findByFingerprint(fp) {
    const i = store.identities.find((x) => x.aadhaar_fingerprint === fp);
    if (!i) return null;
    return {
      employee_id: i.employee_id,
      aadhaar_last4: i.aadhaar_last4,
      employee_status: i.employee_status === undefined ? 1 : i.employee_status,
      period_no: i.period_no || 1,
      period_state: i.period_state || "open",
      last_ended_on: i.last_ended_on || null,
    };
  },
  async createIdentity(_tx, row) {
    if (store.identities.some((x) => x.aadhaar_fingerprint === row.aadhaar_fingerprint)) {
      throw new Error("uq_aadhaar_identity_fingerprint");
    }
    if (store.identities.some((x) => x.employee_id === row.employee_id)) {
      throw new Error("uq_aadhaar_identity_employee");
    }
    const id = store.nextIdentity++;
    store.identities.push({ aadhaar_identity_id: id, ...row });
    return id;
  },
  async getIdentity(employeeId) {
    const i = store.identities.find((x) => x.employee_id === Number(employeeId));
    if (!i) return null;
    const { aadhaar_ciphertext, aadhaar_iv, aadhaar_auth_tag, aadhaar_fingerprint, ...safe } = i;
    return safe;
  },
  async getIdentityForDecrypt(employeeId) {
    return store.identities.find((x) => x.employee_id === Number(employeeId)) || null;
  },
});

const build = () => {
  const store = new Store();
  return { store, uc: aadhaarUsecase(makeRepo(store)) };
};

const VERIFY = {
  aadhaar_number: AADHAAR_A,
  consent_given: true,
  demographics: { name: "Verified Person", dob: "01-02-1990", gender: "MALE", address: "12 Main Road" },
};

/* ===================================================== the number itself = */
describe("validation", () => {
  it("accepts a well-formed number and normalises spacing", () => {
    const spaced = `${AADHAAR_A.slice(0, 4)} ${AADHAAR_A.slice(4, 8)} ${AADHAAR_A.slice(8)}`;
    assert.equal(aadhaarCrypto.normalise(spaced), AADHAAR_A);
    assert.equal(aadhaarCrypto.normalise(AADHAAR_A.replace(/(\d{4})(\d{4})/, "$1-$2")), AADHAAR_A);
  });

  it("rejects the wrong length, non-digits, and a leading 0 or 1", () => {
    for (const bad of ["1234", "12345678901234", "abcdabcdabcd", "", null]) {
      assert.throws(() => aadhaarCrypto.normalise(bad));
    }
    assert.throws(() => aadhaarCrypto.normalise("0" + AADHAAR_A.slice(1)), /may not begin with 0 or 1/);
    assert.throws(() => aadhaarCrypto.normalise("1" + AADHAAR_A.slice(1)), /may not begin with 0 or 1/);
  });

  it("catches a typo through the Verhoeff checksum", () => {
    // Flip the last digit: the checksum must reject it.
    const wrong = AADHAAR_A.slice(0, 11) + String((Number(AADHAAR_A[11]) + 1) % 10);
    assert.throws(() => aadhaarCrypto.normalise(wrong), /failed its checksum/);
    // And a transposition, which is the other common mistake.
    const a = AADHAAR_A.split("");
    if (a[3] !== a[4]) {
      [a[3], a[4]] = [a[4], a[3]];
      assert.throws(() => aadhaarCrypto.normalise(a.join("")), /checksum/);
    }
  });

  it("never repeats the number back in an error message", () => {
    for (const bad of ["0" + AADHAAR_A.slice(1), AADHAAR_A.slice(0, 11) + "0", "12345"]) {
      try {
        aadhaarCrypto.normalise(bad);
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(!err.message.includes(bad), `the message leaked the input: ${err.message}`);
      }
    }
  });
});

describe("the crypto", () => {
  it("encrypts with a fresh IV, so equal numbers do not look equal", () => {
    const a = aadhaarCrypto.encrypt(AADHAAR_A);
    const b = aadhaarCrypto.encrypt(AADHAAR_A);
    assert.notEqual(a.iv.toString("hex"), b.iv.toString("hex"));
    assert.notEqual(a.ciphertext.toString("hex"), b.ciphertext.toString("hex"));
    assert.equal(aadhaarCrypto.decrypt(a), AADHAAR_A);
    assert.equal(aadhaarCrypto.decrypt(b), AADHAAR_A);
  });

  it("detects tampering through the GCM tag", () => {
    const enc = aadhaarCrypto.encrypt(AADHAAR_A);
    const corrupted = Buffer.from(enc.ciphertext);
    corrupted[0] = corrupted[0] ^ 0xff;
    assert.throws(() => aadhaarCrypto.decrypt({ ...enc, ciphertext: corrupted }), /integrity check/);
  });

  it("fingerprints deterministically, and differently for different numbers", () => {
    assert.equal(aadhaarCrypto.fingerprint(AADHAAR_A), aadhaarCrypto.fingerprint(AADHAAR_A));
    assert.notEqual(aadhaarCrypto.fingerprint(AADHAAR_A), aadhaarCrypto.fingerprint(AADHAAR_B));
    assert.match(aadhaarCrypto.fingerprint(AADHAAR_A), /^[0-9a-f]{64}$/);
  });

  it("the fingerprint is KEYED, so a dump alone cannot be enumerated", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "services/aadhaar_crypto.js"), "utf8");
    assert.match(src, /createHmac\("sha256", config\.fingerprintSecret\)/);
    assert.ok(!/createHash\("sha256"\)[\s\S]{0,80}aadhaar/i.test(src), "an unkeyed hash would be enumerable");
  });

  it("uses a separate key from the encryption key", () => {
    assert.notEqual(
      aadhaarConfig.encryptionKey.toString("hex"),
      aadhaarConfig.fingerprintSecret.toString("hex")
    );
    const cfg = fs.readFileSync(path.join(__dirname, "..", "config/aadhaar.js"), "utf8");
    assert.match(cfg, /AADHAAR_ENCRYPTION_KEY/);
    assert.match(cfg, /AADHAAR_FINGERPRINT_KEY/);
  });

  it("does not reuse utils/encryptAES, which has a committed key and a fixed IV", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "services/aadhaar_crypto.js"), "utf8");
    assert.ok(!/encryptAES/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "must not use the vendor cipher");
    assert.match(src, /aes-256-gcm/);
  });

  it("fails closed when no key is configured", () => {
    const saved = { ...process.env };
    delete process.env.AADHAAR_ENCRYPTION_KEY;
    delete process.env.AADHAAR_FINGERPRINT_KEY;
    for (const m of ["../config/aadhaar", "../services/aadhaar_crypto"]) delete require.cache[require.resolve(m)];
    const cfg = require("../config/aadhaar");
    const c = require("../services/aadhaar_crypto");
    assert.equal(cfg.enabled, false);
    assert.throws(() => c.encrypt(AADHAAR_A), /not configured/);
    assert.throws(() => c.fingerprint(AADHAAR_A), /not configured/);
    process.env = saved;
    for (const m of ["../config/aadhaar", "../services/aadhaar_crypto"]) delete require.cache[require.resolve(m)];
  });
});

/* ================================================== verify and duplicate = */
describe("verify", () => {
  it("records the verification and says to create when nobody holds this Aadhaar", async () => {
    const { store, uc } = build();
    const res = await uc.verify(VERIFY, { actorEmployeeId: 7, ip: "10.0.0.1" });
    assert.equal(res.duplicate, false);
    assert.equal(res.next_action, "create");
    assert.equal(res.aadhaar_last4, AADHAAR_A.slice(-4));
    assert.equal(store.verifications.length, 1);
    assert.equal(store.verifications[0].status, "verified");
  });

  it("refuses without consent, and records consent when given", async () => {
    const { store, uc } = build();
    await assert.rejects(() => uc.verify({ ...VERIFY, consent_given: false }), /consent_given must be true/);
    await uc.verify(VERIFY, { actorEmployeeId: 7, ip: "10.0.0.1" });
    const v = store.verifications[0];
    assert.equal(v.consent_given, 1);
    assert.equal(v.consent_actor_employee_id, 7);
    assert.equal(v.consent_ip, "10.0.0.1");
    assert.ok(v.consent_version);
    assert.ok(v.consent_at);
  });

  it("captures the provider, its reference and the verified timestamp", async () => {
    const { store, uc } = build();
    await uc.verify({ ...VERIFY, provider: "somekyc", provider_reference: "REF-991" });
    const v = store.verifications[0];
    assert.equal(v.provider, "somekyc");
    assert.equal(v.provider_reference, "REF-991");
    assert.ok(v.verified_at);
    assert.ok(v.expires_at);
  });

  it("maps only the allowed demographic fields", () => {
    const mapped = EmployeeAadhaarUsecase.mapDemographics({
      name: "Verified Person",
      dob: "01-02-1990",
      gender: "FEMALE",
      address: "12 Main Road",
      // None of these may ever be honoured:
      designation_id: 99,
      store_id: 99,
      salary: "100000",
      status: 0,
      employee_id: 5,
    });
    assert.deepEqual(mapped, {
      employee_name: "Verified Person",
      dob: "1990-02-01",
      gender: "F",
      permanent_address: "12 Main Road",
    });
  });

  it("reads dd-mm-yyyy and yyyy-mm-dd, and drops an unreadable date", () => {
    assert.equal(EmployeeAadhaarUsecase.mapDemographics({ dob: "1990-02-01" }).dob, "1990-02-01");
    assert.equal(EmployeeAadhaarUsecase.mapDemographics({ dob: "01/02/1990" }).dob, "1990-02-01");
    assert.equal(EmployeeAadhaarUsecase.mapDemographics({ dob: "sometime in 1990" }).dob, undefined);
  });

  it("strips any Aadhaar-looking key from the demographics payload", async () => {
    const { store, uc } = build();
    await uc.verify({
      ...VERIFY,
      demographics: { name: "X", aadhaar_number: AADHAAR_A, uid: AADHAAR_A, aadhaar: AADHAAR_A },
    });
    const stored = store.verifications[0].demographics_json;
    assert.ok(!stored.includes(AADHAAR_A), "the number must never reach demographics_json");
    assert.ok(stored.includes("X"));
  });

  it("DUPLICATE: an Aadhaar already held sends HR to Rejoin, not to Create", async () => {
    const { store, uc } = build();
    store.identities.push({
      employee_id: 412,
      aadhaar_fingerprint: aadhaarCrypto.fingerprint(AADHAAR_A),
      aadhaar_last4: AADHAAR_A.slice(-4),
      employee_status: 0,
      period_no: 1,
      period_state: "closed",
      last_ended_on: "2024-05-31",
    });

    const res = await uc.verify(VERIFY);
    assert.equal(res.duplicate, true);
    assert.equal(res.next_action, "rejoin");
    assert.equal(res.existing_employee.employee_id, 412);
    assert.equal(res.existing_employee.is_active, false);
    assert.equal(res.existing_employee.last_ended_on, "2024-05-31");
    assert.match(res.message, /Use Rejoin on that employee_id/);
    // No ciphertext is stored on a duplicate verification: there is nothing
    // to create, so there is nothing to hold.
    assert.equal(store.verifications[0].aadhaar_ciphertext, null);
  });

  it("DUPLICATE: and says so plainly when the person is currently employed", async () => {
    const { store, uc } = build();
    store.identities.push({
      employee_id: 88,
      aadhaar_fingerprint: aadhaarCrypto.fingerprint(AADHAAR_A),
      aadhaar_last4: AADHAAR_A.slice(-4),
      employee_status: 1,
      period_no: 2,
      period_state: "open",
    });
    const res = await uc.verify(VERIFY);
    assert.equal(res.next_action, "already_employed");
    assert.match(res.message, /Do not create a second record/);
  });
});

/* ==================================================== attach to employee = */
describe("attachToEmployee", () => {
  const attached = async () => {
    const { store, uc } = build();
    const v = await uc.verify(VERIFY, { actorEmployeeId: 7 });
    const res = await uc.attachToEmployee({}, v.verification_id, 900, { actorEmployeeId: 7 });
    return { store, uc, verificationId: v.verification_id, res };
  };

  it("writes the identity and returns the demographic fields to apply", async () => {
    const { store, res } = await attached();
    assert.equal(store.identities.length, 1);
    assert.equal(store.identities[0].employee_id, 900);
    assert.equal(res.aadhaar_last4, AADHAAR_A.slice(-4));
    assert.deepEqual(res.demographic_fields, {
      employee_name: "Verified Person",
      dob: "1990-02-01",
      gender: "M",
      permanent_address: "12 Main Road",
    });
  });

  it("clears the ciphertext from the verification once the identity holds it", async () => {
    const { store, verificationId } = await attached();
    const v = store.verifications.find((x) => x.verification_id === verificationId);
    assert.equal(v.status, "consumed");
    assert.equal(v.aadhaar_ciphertext, null);
    assert.equal(v.aadhaar_iv, null);
    assert.equal(v.aadhaar_auth_tag, null);
    assert.ok(store.identities[0].aadhaar_ciphertext, "the identity keeps it");
  });

  it("a verification cannot be consumed twice", async () => {
    const { uc, verificationId } = await attached();
    await assert.rejects(() => uc.attachToEmployee({}, verificationId, 901), /already been consumed/);
  });

  it("an expired verification is refused", async () => {
    const { store, uc } = build();
    const v = await uc.verify(VERIFY);
    store.verifications[0].expires_at = new Date(Date.now() - 1000);
    await assert.rejects(() => uc.attachToEmployee({}, v.verification_id, 900), /has expired/);
  });

  it("a second employee cannot take an Aadhaar that is already attached", async () => {
    const { store, uc } = build();
    const first = await uc.verify(VERIFY);
    await uc.attachToEmployee({}, first.verification_id, 900);
    const second = await uc.verify(VERIFY); // duplicate: no ciphertext held
    await assert.rejects(
      () => uc.attachToEmployee({}, second.verification_id, 901),
      /already belongs to employee 900|carries no Aadhaar/
    );
    assert.equal(store.identities.length, 1);
  });
});

/* ============================================================ disclosure = */
describe("the number never escapes", () => {
  it("the display record carries last4 and provenance, never the number", async () => {
    const { uc } = build();
    const v = await uc.verify(VERIFY);
    await uc.attachToEmployee({}, v.verification_id, 900);
    const shown = await uc.getIdentity(900);
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(AADHAAR_A), "the number must not appear");
    assert.ok(!/fingerprint/i.test(text), "nor the fingerprint");
    assert.equal(shown.aadhaar_last4, AADHAAR_A.slice(-4));
  });

  it("the audit view of a verification carries no ciphertext or fingerprint", async () => {
    const { uc } = build();
    const v = await uc.verify(VERIFY);
    const audit = await uc.getVerification(v.verification_id);
    const text = JSON.stringify(audit);
    assert.ok(!text.includes(AADHAAR_A));
    assert.ok(!/ciphertext|fingerprint/i.test(text));
    assert.equal(audit.aadhaar_last4, AADHAAR_A.slice(-4));
  });

  it("only one repository query returns the ciphertext, and it is named for it", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "repository/employee_aadhaar.js"), "utf8");
    const selects = src.match(/SELECT[\s\S]*?FROM/g) || [];
    const withCiphertext = selects.filter((s) => /aadhaar_ciphertext/.test(s));
    assert.equal(withCiphertext.length, 2, "the decrypt read and the locked verification, and nothing else");
    assert.match(src, /getIdentityForDecrypt/);
    assert.ok(!/SELECT \*/.test(src), "no SELECT * anywhere");
  });

  it("revealing the full number is logged with who read it", async () => {
    const { uc } = build();
    const v = await uc.verify(VERIFY);
    await uc.attachToEmployee({}, v.verification_id, 900);
    const revealed = await uc.revealFullNumber(900, { actorEmployeeId: 7 });
    assert.equal(revealed.aadhaar_number, AADHAAR_A);
    const src = fs.readFileSync(path.join(__dirname, "employee_aadhaar.js"), "utf8");
    const block = src.slice(src.indexOf("async revealFullNumber"));
    assert.match(block, /FULL-NUMBER-READ/);
    // The log line must name the reader and the last four, never the number.
    assert.ok(!/\$\{number\}/.test(block), "the log must not interpolate the number");
  });

  it("nothing in the Aadhaar layer logs a plaintext number", () => {
    for (const f of ["../services/aadhaar_crypto.js", "employee_aadhaar.js", "../repository/employee_aadhaar.js"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/console\.log/.test(code), `${f} must not console.log`);
      assert.ok(!/description:.*aadhaar_number/i.test(code), `${f} must not log the number`);
    }
  });

  it("B3 treats the new field names as sensitive, but not last4", () => {
    const { isSensitiveField } = require("../constants/sensitive_fields");
    for (const f of ["aadhaar_number", "aadhaar_ciphertext", "aadhaar_fingerprint", "aadhaar_card_no"]) {
      assert.equal(isSensitiveField(f), true, `${f} must be sensitive`);
    }
    assert.equal(isSensitiveField("aadhaar_last4"), false, "last4 exists to be displayed");
  });
});
