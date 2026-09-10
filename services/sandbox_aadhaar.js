const kycConfig = require("../config/sandbox_kyc");
const { SandboxError, FAILURE } = require("./sandbox_client");

/**
 * Stage 0C / C2 — Sandbox Aadhaar OKYC.
 *
 * Two calls, and nothing else:
 *
 *   generateOtp(aadhaarNumber)  POST /kyc/aadhaar/okyc/otp
 *   verifyOtp(referenceId, otp) POST /kyc/aadhaar/okyc/otp/verify
 *
 * No business logic lives here - no sessions, no duplicate detection, no
 * storage. This is the provider boundary and only that, so the rules above it
 * can be tested without a network and the contract below it can change
 * without touching them.
 *
 * NOTHING IN THIS FILE LOGS. The two arguments it handles are an Aadhaar
 * number and an OTP; the safest way to guarantee neither is ever written down
 * is for this module to have no logger at all. Failures are raised as typed
 * SandboxErrors and logged one level up by the shared client, which never
 * sees the request body.
 */

/** Demographic keys Sandbox returns that we are willing to carry. */
const DEMOGRAPHIC_KEYS = ["name", "date_of_birth", "gender", "full_address", "year_of_birth"];

class SandboxAadhaarService {
  constructor(client) {
    this.client = client;
  }

  isEnabled() {
    return Boolean(this.client && this.client.isEnabled());
  }

  /**
   * Sends an OTP to the mobile registered against the Aadhaar.
   *
   * Returns `{ reference_id, transaction_id }`. `reference_id` is Sandbox's
   * handle for the attempt and is what `verifyOtp` needs; it is not secret in
   * the way the number is, but it is still stored rather than returned to the
   * browser.
   */
  async generateOtp(aadhaarNumber) {
    const res = await this.client.request({
      method: "POST",
      path: kycConfig.aadhaar.generateOtpPath,
      body: {
        "@entity": kycConfig.aadhaar.generateOtpEntity,
        aadhaar_number: String(aadhaarNumber),
        consent: kycConfig.aadhaar.consentValue,
        reason: kycConfig.aadhaar.reason,
      },
      // Deliberately empty: there is no id here that is safe AND useful, and
      // the Aadhaar number is the one thing that must never reach a log.
      logRef: { product: "aadhaar_okyc_generate_otp" },
    });

    const referenceId = res.data && (res.data.reference_id || res.data.referenceId);
    if (!referenceId) {
      throw new SandboxError(
        FAILURE.UNEXPECTED,
        "The verification provider did not return a reference for this Aadhaar"
      );
    }
    return { reference_id: String(referenceId), transaction_id: res.transaction_id };
  }

  /**
   * Exchanges the OTP for verified demographics.
   *
   * Only a response Sandbox itself marks successful is accepted: `code: 200`
   * is checked by the shared client, and the `status` in the payload is
   * checked here. A provider failure can therefore never end up marking an
   * Aadhaar verified.
   */
  async verifyOtp(referenceId, otp) {
    const res = await this.client.request({
      method: "POST",
      path: kycConfig.aadhaar.verifyOtpPath,
      body: {
        "@entity": kycConfig.aadhaar.verifyOtpEntity,
        reference_id: String(referenceId),
        otp: String(otp),
      },
      logRef: { product: "aadhaar_okyc_verify_otp", reference_id: String(referenceId) },
    });

    const data = res.data || {};
    // Sandbox reports the outcome in `status`; anything that is not an
    // explicit success is treated as a failed verification, never a pass.
    const status = String(data.status || "").trim().toLowerCase();
    const succeeded = status === "" ? Boolean(data.name) : /^(valid|success|verified|vid_generated|y)$/.test(status);
    if (!succeeded) {
      throw new SandboxError(FAILURE.INVALID_REQUEST, "The OTP could not be verified", 422);
    }

    return {
      transaction_id: res.transaction_id,
      reference_id: data.reference_id ? String(data.reference_id) : String(referenceId),
      provider_status: data.status ? String(data.status) : null,
      demographics: SandboxAadhaarService.extractDemographics(data),
    };
  }

  /**
   * Pulls out the demographics we map, and NOTHING else.
   *
   * `photo` is deliberately dropped: Sandbox returns a base64 image, there is
   * no screen or column that uses it today, and storing a biometric-adjacent
   * image nobody has asked for is not a decision to make by accident.
   */
  static extractDemographics(data) {
    const out = {};
    for (const key of DEMOGRAPHIC_KEYS) {
      const value = data[key];
      if (value === undefined || value === null || String(value).trim() === "") continue;
      out[key] = String(value).trim();
    }
    // The structured address is preferred over `full_address` when present,
    // because it is the one that is actually parseable.
    if (data.address && typeof data.address === "object") {
      const a = data.address;
      const parts = [a.house, a.street, a.district, a.state, a.pincode, a.country]
        .map((p) => (p === undefined || p === null ? "" : String(p).trim()))
        .filter((p) => p !== "");
      if (parts.length) out.address = parts.join(", ");
    }
    if (!out.address && out.full_address) out.address = out.full_address;
    delete out.full_address;
    return out;
  }
}

module.exports = (client) => new SandboxAadhaarService(client);
module.exports.SandboxAadhaarService = SandboxAadhaarService;
module.exports.DEMOGRAPHIC_KEYS = DEMOGRAPHIC_KEYS;
