const nodeCrypto = require("crypto");
const logger = require("../utils/logger");
const crypto = require("../services/aadhaar_crypto");
const config = require("../config/aadhaar");
const kycConfig = require("../config/sandbox_kyc");
const { SandboxError, FAILURE } = require("../services/sandbox_client");

/**
 * Stage 0C / C2 — Aadhaar verification, and what it is for.
 *
 * The flow HR follows:
 *
 *   verify  ->  we already know this person?  ->  yes: Rejoin employee 412
 *                                            \->  no:  confirm the verified
 *                                                      details, then Create
 *
 * DUPLICATE DETECTION IS THE POINT. A person is one `employee_id` for life.
 * The weakest moment for that rule is a returning employee whose name is
 * spelled differently, so HR creates a second record and the employment
 * history splits in two. A verified Aadhaar closes that: the fingerprint is
 * unique, so the same person cannot become two employees, and the answer HR
 * gets is not a constraint error but "this is employee 412, who left on
 * 2024-05-31 - use Rejoin".
 *
 * WHAT VERIFICATION MEANS HERE. `provider: manual` records that an authorised
 * HR user checked the number against the issuing authority themselves and is
 * attesting to it, with consent captured. Every field a real provider
 * integration needs - provider name, reference, verified timestamp, failure
 * reason - is captured now, so wiring one later is a new service module and a
 * config value, and Create Employee does not change again.
 */

/**
 * The ONLY employee fields a verified demographic payload may fill.
 *
 * An allowlist, not a merge: a provider payload must never be able to set a
 * designation, a store, a salary or a status. Those are decisions, not facts
 * about a person.
 */
const DEMOGRAPHIC_MAP = {
  // Sandbox's field names, verbatim, so the mapping needs no translation
  // layer in between to get out of step. `date_of_birth` is what the OKYC
  // verify response actually carries; `dob` is accepted too because the
  // manual path uses the column name.
  name: "employee_name",
  date_of_birth: "dob",
  dob: "dob",
  gender: "gender",
  address: "permanent_address",
};

/** Gender comes back spelled several ways; the column holds one letter. */
const GENDER = { M: "M", MALE: "M", F: "F", FEMALE: "F", O: "O", OTHER: "O", TRANSGENDER: "O" };

class ValidationError extends Error {
  constructor(message, httpCode = 422) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = httpCode;
  }
}
class ConflictError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ConflictError";
    this.httpCode = 409;
    this.detail = detail;
  }
}

const isoDate = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const t = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // dd-mm-yyyy and dd/mm/yyyy are what Indian KYC payloads usually carry.
  const m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

class EmployeeAadhaarUsecase {
  /**
   * `sandboxAadhaar` is the provider boundary. When it is absent or disabled
   * the OTP flow refuses rather than falling back to anything: a Sandbox
   * outage must never quietly become a manual attestation.
   */
  constructor(aadhaarRepo, sandboxAadhaar) {
    this.repo = aadhaarRepo;
    this.provider = sandboxAadhaar || null;
  }

  /** An opaque handle. The numeric id is a sequence, and therefore guessable. */
  static newSessionToken() {
    return nodeCrypto.randomBytes(32).toString("hex");
  }

  _assertProvider() {
    if (!this.provider || !this.provider.isEnabled()) {
      throw new SandboxError(
        FAILURE.NOT_CONFIGURED,
        "Aadhaar verification is not available: the Sandbox KYC provider is not configured on this server",
        503
      );
    }
  }

  /**
   * Step 1. Sends an OTP to the mobile registered against the Aadhaar and
   * opens a local session.
   *
   * The number is validated and checksummed BEFORE the provider is called, so
   * a typo costs nothing, and is reduced to fingerprint + ciphertext + last
   * four immediately afterwards. Nothing downstream holds it.
   */
  async initiate(input, { actorEmployeeId = null, ip = null } = {}) {
    this.assertEnabled();
    this._assertProvider();

    if (input.consent_given !== true) {
      throw new ValidationError(
        "consent_given must be true: an Aadhaar may not be sent for verification without the holder's consent"
      );
    }

    // Throws a ValidationError naming the problem and never the number.
    const digits = crypto.normalise(input.aadhaar_number);
    const derived = crypto.derive(digits);

    // The provider call happens before anything is written, so a refusal
    // leaves no half-open session behind.
    const started = await this.provider.generateOtp(digits);

    const expiresAt = new Date(Date.now() + config.verificationTtlMinutes * 60 * 1000);
    const sessionToken = EmployeeAadhaarUsecase.newSessionToken();
    const verificationId = await this.repo.createVerification({
      aadhaar_fingerprint: derived.fingerprint,
      aadhaar_last4: derived.last4,
      aadhaar_ciphertext: derived.ciphertext,
      aadhaar_iv: derived.iv,
      aadhaar_auth_tag: derived.auth_tag,
      key_version: derived.key_version,
      status: "initiated",
      provider: "sandbox",
      provider_reference_id: started.reference_id,
      provider_transaction_id: started.transaction_id,
      consent_given: 1,
      consent_version: config.consentVersion,
      consent_actor_employee_id: actorEmployeeId,
      consent_ip: ip,
      consent_at: new Date(),
      initiated_by_employee_id: actorEmployeeId,
      initiated_at: new Date(),
      session_token: sessionToken,
      expires_at: expiresAt,
    });

    this._log(
      logger.LEVEL.INFO,
      "OTP-SENT",
      `verification ${verificationId} initiated for Aadhaar ending ${derived.last4}`,
      { verificationId, last4: derived.last4, actorEmployeeId }
    );

    return {
      code: 200,
      verification_token: sessionToken,
      aadhaar_last4: derived.last4,
      masked_aadhaar: crypto.mask(digits),
      status: "initiated",
      expires_at: expiresAt.toISOString(),
      message: "An OTP has been sent to the mobile number registered against this Aadhaar.",
    };
  }

  /**
   * Step 2. Exchanges the OTP for verified demographics, and only then
   * answers the duplicate question.
   *
   * THE OTP IS NEVER STORED, NEVER LOGGED AND NEVER ECHOED. It exists as an
   * argument to one provider call and nowhere else - not on the session row,
   * not in an error message, not in a log line.
   */
  async verifyOtp(input, { actorEmployeeId = null } = {}) {
    this.assertEnabled();
    this._assertProvider();

    const token = String(input.verification_token || "").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new ValidationError("verification_token is required");
    if (input.otp === undefined || input.otp === null || String(input.otp).trim() === "") {
      throw new ValidationError("otp is required");
    }

    const session = await this.repo.findVerificationByToken(token);
    if (!session) throw new ValidationError("that verification session does not exist", 404);
    if (session.status !== "initiated") {
      throw new ConflictError(`that verification session has already been ${session.status}`);
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await this.repo.updateVerification(session.verification_id, "initiated", {
        status: "expired",
        failure_category: "session_expired",
      });
      throw new ValidationError("that verification session has expired; start again");
    }
    // The session belongs to whoever started it. Another HR user cannot
    // finish somebody else's Aadhaar check.
    if (
      session.initiated_by_employee_id !== null &&
      actorEmployeeId !== null &&
      Number(session.initiated_by_employee_id) !== Number(actorEmployeeId)
    ) {
      throw new ConflictError("that verification session was started by another user");
    }
    if (Number(session.otp_attempts) >= 5) {
      await this.repo.updateVerification(session.verification_id, "initiated", {
        status: "failed",
        failure_category: "too_many_otp_attempts",
      });
      throw new ValidationError("too many OTP attempts; start the verification again");
    }

    await this.repo.incrementOtpAttempts(session.verification_id);

    let verified;
    try {
      verified = await this.provider.verifyOtp(session.provider_reference_id, String(input.otp).trim());
    } catch (err) {
      const category = err instanceof SandboxError ? err.category : "provider_error";
      // A failure is recorded but the session is only CLOSED when it cannot
      // be retried; a wrong digit should let HR try again.
      const terminal = category !== FAILURE.INVALID_REQUEST;
      if (terminal) {
        await this.repo.updateVerification(session.verification_id, "initiated", {
          status: "failed",
          failure_category: category,
        });
      }
      this._log(
        logger.LEVEL.ERROR,
        "OTP-VERIFY-FAILED",
        `verification ${session.verification_id} failed: ${category}`,
        { verificationId: session.verification_id, category, actorEmployeeId }
      );
      throw err;
    }

    const demographics = EmployeeAadhaarUsecase.stripAadhaarKeys(verified.demographics);
    const updated = await this.repo.updateVerification(session.verification_id, "initiated", {
      status: "verified",
      verified_at: new Date(),
      provider_transaction_id: verified.transaction_id,
      demographics_json: JSON.stringify(demographics),
    });
    if (updated === 0) throw new ConflictError("that verification session changed while it was being verified");

    const existing = await this.repo.findByFingerprint(session.aadhaar_fingerprint);
    if (existing) {
      // There is nobody to create, so there is no reason to keep holding an
      // encrypted Aadhaar on this session until it expires.
      await this.repo.updateVerification(session.verification_id, "verified", {
        aadhaar_ciphertext: null,
        aadhaar_iv: null,
        aadhaar_auth_tag: null,
      });
    }
    this._log(
      logger.LEVEL.INFO,
      "VERIFIED",
      `verification ${session.verification_id} verified for Aadhaar ending ${session.aadhaar_last4}` +
        (existing ? `; already held by employee ${existing.employee_id}` : ""),
      { verificationId: session.verification_id, last4: session.aadhaar_last4, actorEmployeeId }
    );

    return EmployeeAadhaarUsecase.decision({
      verificationId: session.verification_id,
      last4: session.aadhaar_last4,
      demographics,
      existing,
    });
  }

  /** Drops anything that looks like it carries the number itself. */
  static stripAadhaarKeys(demographics) {
    const out = { ...(demographics || {}) };
    for (const k of Object.keys(out)) {
      if (/aadhaar|uid|vid/i.test(k)) delete out[k];
    }
    return out;
  }

  /**
   * The create / rejoin / already_employed answer. Only ever produced after a
   * verification the provider confirmed - there is no path to this from an
   * unverified session.
   */
  static decision({ verificationId, last4, demographics, existing }) {
    const suggested = EmployeeAadhaarUsecase.mapDemographics(demographics);
    const base = {
      code: 200,
      verification_id: verificationId,
      aadhaar_last4: last4,
      status: "verified",
      verified_demographics: demographics,
      suggested_employee_fields: suggested,
    };
    if (!existing) {
      return {
        ...base,
        duplicate: false,
        next_action: "create",
        message: "No existing employee holds this Aadhaar. Confirm the details and create the employee.",
      };
    }
    const active = Number(existing.employee_status) === 1;
    return {
      ...base,
      duplicate: true,
      employee_id: existing.employee_id,
      existing_employee: {
        employee_id: existing.employee_id,
        is_active: active,
        latest_period_no: existing.period_no,
        latest_period_state: existing.period_state,
        last_ended_on: existing.last_ended_on,
      },
      next_action: active ? "already_employed" : "rejoin",
      message: active
        ? `This Aadhaar already belongs to employee ${existing.employee_id}, who is currently employed. Do not create a second record.`
        : `This Aadhaar already belongs to employee ${existing.employee_id}, who has left. Use Rejoin on that employee_id rather than creating a new one.`,
    };
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.EMPLOYEE_AADHAAR",
      // Nothing passed to `description` or `ref` by this class ever contains
      // a number; only the last four digits and the verification id.
      code: `USECASE.EMPLOYEE_AADHAAR.${code}`,
      description,
      category: "",
      ref,
    });
  }

  assertEnabled() {
    if (!config.enabled) throw new ValidationError(config.DISABLED_MESSAGE, 503);
  }

  /**
   * Maps a verified payload onto employee columns through the allowlist.
   * Anything the provider sends that is not in `DEMOGRAPHIC_MAP` is dropped
   * silently - it is not ours to store.
   */
  static mapDemographics(demographics) {
    const out = {};
    if (!demographics || typeof demographics !== "object") return out;
    for (const [from, to] of Object.entries(DEMOGRAPHIC_MAP)) {
      const value = demographics[from];
      if (value === undefined || value === null || String(value).trim() === "") continue;
      if (to === "dob") {
        if (out.dob) continue; // date_of_birth wins; dob is the fallback spelling
        const d = isoDate(value);
        if (d) out.dob = d;
        continue;
      }
      if (to === "gender") {
        const g = GENDER[String(value).trim().toUpperCase()];
        if (g) out.gender = g;
        continue;
      }
      out[to] = String(value).trim();
    }
    return out;
  }

  /**
   * The MANUAL path: an authorised HR user attests to an Aadhaar they checked
   * themselves. OFF unless AADHAAR_ALLOW_MANUAL is set, never a fallback for
   * a Sandbox outage, and stored with `provider = 'manual'` so it can never
   * be mistaken for a Sandbox-verified record.
   */
  async verify(input, { actorEmployeeId = null, ip = null } = {}) {
    this.assertEnabled();
    if (!kycConfig.allowManualAadhaar) {
      throw new ValidationError(
        "Manual Aadhaar attestation is disabled on this server. Use the Sandbox OTP flow: " +
          "POST /hr/aadhaar/initiate then POST /hr/aadhaar/verify-otp.",
        409
      );
    }

    if (input.consent_given !== true) {
      throw new ValidationError(
        "consent_given must be true: an Aadhaar may not be recorded without the holder's consent"
      );
    }

    // Throws a ValidationError naming the problem and never the number.
    const derived = crypto.derive(input.aadhaar_number);

    // Demographics are what the provider asserted. The number is not part of
    // that payload and is stripped if a caller tries to include it.
    const demographics = { ...(input.demographics || {}) };
    for (const k of Object.keys(demographics)) {
      if (/aadhaar|uid/i.test(k)) delete demographics[k];
    }

    const existing = await this.repo.findByFingerprint(derived.fingerprint);

    const expiresAt = new Date(Date.now() + config.verificationTtlMinutes * 60 * 1000);
    const verificationId = await this.repo.createVerification({
      aadhaar_fingerprint: derived.fingerprint,
      aadhaar_last4: derived.last4,
      aadhaar_ciphertext: existing ? null : derived.ciphertext,
      aadhaar_iv: existing ? null : derived.iv,
      aadhaar_auth_tag: existing ? null : derived.auth_tag,
      key_version: derived.key_version,
      status: "verified",
      provider: "manual",
      provider_reference: input.provider_reference || null,
      verified_at: new Date(),
      consent_given: 1,
      consent_version: config.consentVersion,
      consent_actor_employee_id: actorEmployeeId,
      consent_ip: ip,
      consent_at: new Date(),
      demographics_json: JSON.stringify(demographics),
      expires_at: expiresAt,
    });

    this._log(
      logger.LEVEL.INFO,
      "VERIFIED",
      `verification ${verificationId} recorded for Aadhaar ending ${derived.last4}` +
        (existing ? `; already held by employee ${existing.employee_id}` : ""),
      { verificationId, last4: derived.last4, actorEmployeeId }
    );

    const suggested = EmployeeAadhaarUsecase.mapDemographics(demographics);

    if (existing) {
      // The whole point: HR is told who this is and what to do next, rather
      // than being allowed to create a second record for the same person.
      const active = Number(existing.employee_status) === 1;
      return {
        code: 200,
        verification_id: verificationId,
        aadhaar_last4: derived.last4,
        duplicate: true,
        existing_employee: {
          employee_id: existing.employee_id,
          is_active: active,
          latest_period_no: existing.period_no,
          latest_period_state: existing.period_state,
          last_ended_on: existing.last_ended_on,
        },
        next_action: active ? "already_employed" : "rejoin",
        message: active
          ? `This Aadhaar already belongs to employee ${existing.employee_id}, who is currently employed. Do not create a second record.`
          : `This Aadhaar already belongs to employee ${existing.employee_id}, who has left. Use Rejoin on that employee_id rather than creating a new one.`,
        suggested_employee_fields: suggested,
      };
    }

    return {
      code: 200,
      verification_id: verificationId,
      aadhaar_last4: derived.last4,
      duplicate: false,
      next_action: "create",
      message: "No existing employee holds this Aadhaar. Confirm the details and create the employee.",
      suggested_employee_fields: suggested,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Consumes a verification inside the CALLER's transaction and writes the
   * identity row. Called only by Create Employee, so the identity and the
   * employee it belongs to commit together or not at all.
   *
   * Returns the demographic fields the payload permits, for the caller to
   * apply to the employee row.
   */
  async attachToEmployee(tx, verificationId, employeeId, { actorEmployeeId = null } = {}) {
    this.assertEnabled();

    const v = await this.repo.lockVerificationForUse(tx, verificationId);
    if (!v) throw new ValidationError(`verification ${verificationId} does not exist`);
    if (v.status !== "verified") {
      throw new ConflictError(`verification ${verificationId} has already been ${v.status}`);
    }
    if (new Date(v.expires_at).getTime() < Date.now()) {
      throw new ValidationError(`verification ${verificationId} has expired; verify the Aadhaar again`);
    }
    if (!v.aadhaar_ciphertext) {
      throw new ConflictError(
        `verification ${verificationId} carries no Aadhaar to store; it was raised against an employee who already exists`
      );
    }
    if (Number(v.consent_given) !== 1) {
      throw new ValidationError(`verification ${verificationId} has no recorded consent`);
    }

    // Checked again here, inside the transaction and under the unique index,
    // so two creates racing on the same Aadhaar cannot both succeed.
    const clash = await this.repo.findByFingerprint(v.aadhaar_fingerprint, tx);
    if (clash) {
      throw new ConflictError(
        `this Aadhaar already belongs to employee ${clash.employee_id}; use Rejoin on that employee_id`,
        { existing_employee_id: clash.employee_id }
      );
    }

    await this.repo.createIdentity(tx, {
      employee_id: employeeId,
      aadhaar_fingerprint: v.aadhaar_fingerprint,
      aadhaar_last4: v.aadhaar_last4,
      aadhaar_ciphertext: v.aadhaar_ciphertext,
      aadhaar_iv: v.aadhaar_iv,
      aadhaar_auth_tag: v.aadhaar_auth_tag,
      key_version: v.key_version,
      verification_id: v.verification_id,
      verified_at: v.verified_at,
      created_by: actorEmployeeId,
      updated_by: actorEmployeeId,
    });

    const consumed = await this.repo.consumeVerification(tx, verificationId, employeeId);
    if (consumed === 0) throw new ConflictError(`verification ${verificationId} was consumed concurrently`);

    let demographics = v.demographics_json;
    if (typeof demographics === "string") {
      try {
        demographics = JSON.parse(demographics);
      } catch (err) {
        demographics = null;
      }
    }

    this._log(logger.LEVEL.INFO, "ATTACHED", `Aadhaar ending ${v.aadhaar_last4} attached to employee ${employeeId}`, {
      employeeId,
      verificationId,
      actorEmployeeId,
    });

    return {
      aadhaar_last4: v.aadhaar_last4,
      verified_at: v.verified_at,
      demographic_fields: EmployeeAadhaarUsecase.mapDemographics(demographics),
    };
  }

  /**
   * The mappable demographics of a verification, WITHOUT consuming it.
   *
   * Create Employee needs these BEFORE it inserts the row, not after:
   * `new_employee.employee_name` is NOT NULL, so an HR user who verified an
   * Aadhaar and let the name come from it would otherwise be inserting a NULL
   * name and only filling it in a moment later. Reading them up front is what
   * makes "verify, then create without retyping the name" actually work.
   *
   * This validates nothing and changes nothing; `attachToEmployee` remains the
   * only thing that may consume a verification, and it re-reads the same row
   * under a lock.
   */
  async previewDemographics(verificationId) {
    const v = await this.repo.getVerificationDemographics(verificationId);
    if (!v) return {};
    let demographics = v.demographics_json;
    if (typeof demographics === "string") {
      try {
        demographics = JSON.parse(demographics);
      } catch (err) {
        demographics = null;
      }
    }
    return EmployeeAadhaarUsecase.mapDemographics(demographics);
  }

  /** The display record. Last four and provenance; never the number. */
  async getIdentity(employeeId) {
    return this.repo.getIdentity(employeeId);
  }

  async getVerification(verificationId) {
    return this.repo.getVerification(verificationId);
  }

  /**
   * The full number, for PF and ESI filing. Behind `view_aadhaar_full` at the
   * route, logged every time, and the only caller of the decrypt path.
   */
  async revealFullNumber(employeeId, { actorEmployeeId = null } = {}) {
    this.assertEnabled();
    const row = await this.repo.getIdentityForDecrypt(employeeId);
    if (!row) throw new ValidationError(`employee ${employeeId} has no Aadhaar on record`, 404);
    const number = crypto.decrypt({
      ciphertext: row.aadhaar_ciphertext,
      iv: row.aadhaar_iv,
      auth_tag: row.aadhaar_auth_tag,
    });
    // The access itself is the thing worth recording; the value never is.
    this._log(
      logger.LEVEL.INFO,
      "FULL-NUMBER-READ",
      `employee ${actorEmployeeId} read the full Aadhaar of employee ${employeeId} (ending ${row.aadhaar_last4})`,
      { employeeId, actorEmployeeId }
    );
    return { employee_id: employeeId, aadhaar_number: number, aadhaar_last4: row.aadhaar_last4 };
  }
}

module.exports = (aadhaarRepo, sandboxAadhaar) =>
  new EmployeeAadhaarUsecase(aadhaarRepo, sandboxAadhaar);
module.exports.EmployeeAadhaarUsecase = EmployeeAadhaarUsecase;
module.exports.DEMOGRAPHIC_MAP = DEMOGRAPHIC_MAP;
module.exports.ValidationError = ValidationError;
module.exports.ConflictError = ConflictError;
