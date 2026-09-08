const kycConfig = require("../config/sandbox_kyc");
const { SandboxError, FAILURE } = require("./sandbox_client");

/**
 * Stage 0C / C2 — Sandbox bank account verification (Penny-Less).
 *
 *   GET {base}/bank/{ifsc}/accounts/{account_number}/penniless-verify
 *
 * "Penny-less" because it confirms the account without depositing a rupee
 * into it, so it can be run during onboarding without moving money.
 *
 * Sandbox answers with `account_exists` and `name_at_bank`. Those two are the
 * whole result; what to make of the name is a business decision and lives in
 * `usecase/employee_bank.js`, not here.
 *
 * As with the Aadhaar service, this module has no logger: the account number
 * is in the URL, and the surest way for a URL never to be logged is for the
 * module holding it not to be able to log.
 */

/** A syntactically valid Indian IFSC: four letters, a 0, then six alphanumerics. */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Account numbers vary by bank; this rejects only what cannot be one. */
const ACCOUNT_PATTERN = /^[0-9]{6,20}$/;

class SandboxBankService {
  constructor(client) {
    this.client = client;
  }

  isEnabled() {
    return Boolean(this.client && this.client.isEnabled());
  }

  /**
   * Normalises and checks both inputs locally BEFORE the provider is called.
   *
   * A malformed IFSC is a typo, and spending a paid verification call - and
   * a round trip - to be told so is waste. The error names the field and
   * never the account number.
   */
  static normalise({ account_number, ifsc }) {
    const acc = String(account_number === undefined || account_number === null ? "" : account_number)
      .replace(/[\s-]/g, "");
    const code = String(ifsc === undefined || ifsc === null ? "" : ifsc).replace(/\s/g, "").toUpperCase();

    if (acc === "") throw new SandboxError(FAILURE.INVALID_REQUEST, "account_number is required", 422);
    if (code === "") throw new SandboxError(FAILURE.INVALID_REQUEST, "ifsc is required", 422);
    if (!ACCOUNT_PATTERN.test(acc)) {
      throw new SandboxError(FAILURE.INVALID_REQUEST, "account_number must be 6 to 20 digits", 422);
    }
    if (!IFSC_PATTERN.test(code)) {
      throw new SandboxError(
        FAILURE.INVALID_REQUEST,
        `ifsc '${code}' is not a valid IFSC (four letters, a zero, then six characters)`,
        422
      );
    }
    return { account_number: acc, ifsc: code };
  }

  /**
   * Verifies one account. Returns exactly what Sandbox reported, unjudged.
   *
   * An account Sandbox says does not exist is a RESULT, not an error: it is
   * returned as `account_exists: false` so the caller can record FAILED with
   * a reason, rather than having to distinguish that from the provider being
   * down.
   */
  async pennyLessVerify({ account_number, ifsc }) {
    const clean = SandboxBankService.normalise({ account_number, ifsc });

    const path = kycConfig.bank.pennyLessPathTemplate
      .replace("{ifsc}", encodeURIComponent(clean.ifsc))
      .replace("{account_number}", encodeURIComponent(clean.account_number));

    let res;
    try {
      res = await this.client.request({
        method: kycConfig.bank.method,
        path,
        // The IFSC is safe to record; the account number is not, and is not
        // included even though it is in the path being called.
        logRef: { product: "bank_penny_less", ifsc: clean.ifsc },
      });
    } catch (err) {
      // "No such account" arrives as a 404 from some providers. That is an
      // answer about the account, not a fault, so it is reported as one.
      if (err instanceof SandboxError && err.category === FAILURE.NOT_FOUND) {
        return {
          account_exists: false,
          name_at_bank: null,
          provider_status: FAILURE.NOT_FOUND,
          transaction_id: null,
        };
      }
      throw err;
    }

    const data = res.data || {};
    const exists = data.account_exists === true || String(data.account_exists).toLowerCase() === "true";
    const name = data.name_at_bank === undefined || data.name_at_bank === null ? null : String(data.name_at_bank).trim();

    return {
      account_exists: exists,
      name_at_bank: name === "" ? null : name,
      provider_status: data.status ? String(data.status) : null,
      transaction_id: res.transaction_id,
    };
  }
}

module.exports = (client) => new SandboxBankService(client);
module.exports.SandboxBankService = SandboxBankService;
module.exports.IFSC_PATTERN = IFSC_PATTERN;
module.exports.ACCOUNT_PATTERN = ACCOUNT_PATTERN;
