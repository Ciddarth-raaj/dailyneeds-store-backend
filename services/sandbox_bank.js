const kycConfig = require("../config/sandbox_kyc");
const { SandboxError, FAILURE, SAFE_MESSAGE } = require("./sandbox_client");

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

  /**
   * Normalises an IFSC on its own, for the lookup below.
   *
   * Separate from `normalise` because an IFSC lookup has no account number
   * to check, and demanding one to reuse that method would be contorting the
   * contract to save six lines.
   */
  static normaliseIfsc(ifsc) {
    const code = String(ifsc === undefined || ifsc === null ? "" : ifsc).replace(/[\s-]/g, "").toUpperCase();
    if (code === "") throw new SandboxError(FAILURE.INVALID_REQUEST, "ifsc is required", 422);
    if (!IFSC_PATTERN.test(code)) {
      throw new SandboxError(
        FAILURE.INVALID_REQUEST,
        `ifsc '${code}' is not a valid IFSC (four letters, a zero, then six characters)`,
        422
      );
    }
    return code;
  }

  /** The first of `keys` present on `data` as a non-empty string. */
  static _pick(data, keys) {
    for (const key of keys || []) {
      const raw = data[key];
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      if (value !== "") return value;
    }
    return null;
  }

  /**
   * Resolves one IFSC to its bank and branch name.
   *
   * NOT A VERIFICATION. This spends no Penny-Less check and reads no employee
   * record; it answers a question about a branch code. The caller caches the
   * answer, because the same branch code will be asked about again.
   *
   * AN UNKNOWN IFSC IS A RESULT, NOT A FAULT, and the distinction is the
   * whole point: "there is no such branch code" must reach the user as a
   * correctable typo, while "the provider is down" must not, because telling
   * somebody their correct IFSC is invalid is how they end up retyping a
   * right answer. So a 404 returns `exists: false`, and everything else
   * throws.
   *
   * Only the two names are returned. Sandbox sends city, district, state,
   * address, MICR and the payment-rail flags as well; none of it is read.
   */
  async lookupIfsc(ifsc) {
    const code = SandboxBankService.normaliseIfsc(ifsc);

    const path = kycConfig.bank.ifscPathTemplate.replace("{ifsc}", encodeURIComponent(code));

    let res;
    try {
      res = await this.client.request({
        method: kycConfig.bank.ifscMethod,
        path,
        // An IFSC is a public branch code and identifies no person, so unlike
        // the account number it is safe to record against a failure.
        logRef: { product: "bank_ifsc", ifsc: code },
      });
    } catch (err) {
      if (err instanceof SandboxError && err.category === FAILURE.NOT_FOUND) {
        return { exists: false, ifsc: code, bank_name: null, branch_name: null };
      }
      throw err;
    }

    const data = res.data || {};
    const bankName = SandboxBankService._pick(data, kycConfig.bank.ifscBankNameKeys);
    const branchName = SandboxBankService._pick(data, kycConfig.bank.ifscBranchNameKeys);

    // A 200 with neither name is not an answer we can fill a form from, and
    // caching it would poison the master with blanks. It is reported as an
    // unexpected provider response - not as an invalid IFSC, because we have
    // no evidence the code is wrong.
    if (!bankName || !branchName) {
      throw new SandboxError(
        FAILURE.UNEXPECTED,
        SAFE_MESSAGE[FAILURE.UNEXPECTED],
        502
      );
    }

    return { exists: true, ifsc: code, bank_name: bankName, branch_name: branchName };
  }
}

module.exports = (client) => new SandboxBankService(client);
module.exports.SandboxBankService = SandboxBankService;
module.exports.IFSC_PATTERN = IFSC_PATTERN;
module.exports.ACCOUNT_PATTERN = ACCOUNT_PATTERN;
