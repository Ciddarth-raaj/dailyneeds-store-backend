const kycConfig = require("../config/sandbox_kyc");
const { SandboxError, FAILURE } = require("../services/sandbox_client");

/**
 * Stage 0C / C2 — resolving an IFSC to a bank and branch name.
 *
 * Used while ENTERING bank details, so that HR types a branch code and the
 * bank and branch fill themselves in. It is not a verification of anything:
 * it spends no Penny-Less check, reads no employee record, and writes nothing
 * to the employee master. The Penny-Less contract is untouched by it.
 *
 * ====================================================== WHY IT IS CACHED ===
 *
 * A provider call costs money and an IFSC-to-branch mapping is the same
 * answer for everybody who banks at that branch. The first employee at a
 * branch pays for the lookup; every employee after them is free, for
 * `ifscCacheDays`. That window is a policy and lives in config, so no
 * comparison in this file reads a number.
 *
 * ================================================= THREE OUTCOMES, KEPT APART
 *
 * The distinction this module exists to preserve:
 *
 *   FOUND        a bank and a branch. Fill the form in.
 *   INVALID      the provider says there is no such branch code. A typo the
 *                user can fix, said plainly.
 *   UNAVAILABLE  the provider could not answer. NOT a typo. Telling somebody
 *                their correct IFSC is invalid because a server was down is
 *                how they end up retyping a right answer until they give up.
 *
 * An INVALID result is never cached. A negative answer is not reference data:
 * a branch code that does not exist today may be issued next year, and a
 * cached "no" would outlive the truth. It also means a provider hiccup
 * misread as a "no" could never become permanent.
 */

/** Four letters, a zero, then six alphanumerics. */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Upper-case, no spaces or dashes. The cache key is always this shape. */
const normalise = (ifsc) =>
  String(ifsc === undefined || ifsc === null ? "" : ifsc)
    .replace(/[\s-]/g, "")
    .toUpperCase();

class IfscLookupUsecase {
  /**
   * @param {object} repo   repository/ifsc_master
   * @param {object} bank   services/sandbox_bank, for `lookupIfsc`
   * @param {function} [now] injectable clock, so freshness can be tested
   *   without waiting six months.
   */
  constructor(repo, bankService, now) {
    this.repo = repo;
    this.bank = bankService || null;
    this.now = now || (() => new Date());
  }

  /** Days since the provider last confirmed this row, or Infinity if unknown. */
  _ageInDays(lastCheckedAt) {
    const checked = lastCheckedAt instanceof Date ? lastCheckedAt : new Date(lastCheckedAt);
    if (!checked || Number.isNaN(checked.getTime())) return Infinity;
    return (this.now().getTime() - checked.getTime()) / 86400000;
  }

  /** Whether a cached row may be served without asking the provider again. */
  isFresh(row) {
    if (!row || !row.bank_name || !row.branch_name) return false;
    return this._ageInDays(row.last_checked_at) < kycConfig.bank.ifscCacheDays;
  }

  /**
   * @returns {Promise<object>} one of
   *   { code: 200, ifsc, bank_name, branch_name }
   *   { code: 404, ifsc, msg }                    invalid IFSC
   *   { code: 422, msg }                          malformed, no call made
   *   { code: 502|503, msg }                      provider could not answer
   */
  async lookup(rawIfsc) {
    const ifsc = normalise(rawIfsc);

    // Checked here, before anything else, so a typo costs a round trip to
    // this server and not a provider call. The regex is the same one the
    // Penny-Less path and the frontend use.
    if (!IFSC_PATTERN.test(ifsc)) {
      return {
        code: 422,
        msg: "That IFSC does not look right. It is four letters, a zero, then six characters.",
      };
    }

    const cached = await this.repo.get(ifsc);
    if (this.isFresh(cached)) {
      // The whole point. No provider call, no charge, same answer.
      return {
        code: 200,
        ifsc,
        bank_name: cached.bank_name,
        branch_name: cached.branch_name,
        cached: true,
      };
    }

    if (!this.bank || !this.bank.isEnabled()) {
      // A stale row is still better than nothing when the provider is off:
      // the branch almost certainly has not moved, and refusing to fill the
      // form in helps nobody. It is served as stale rather than as fresh.
      if (cached && cached.bank_name && cached.branch_name) {
        return {
          code: 200,
          ifsc,
          bank_name: cached.bank_name,
          branch_name: cached.branch_name,
          cached: true,
          stale: true,
        };
      }
      return { code: 503, msg: "The bank lookup provider is not configured on this server" };
    }

    let result;
    try {
      result = await this.bank.lookupIfsc(ifsc);
    } catch (err) {
      if (err instanceof SandboxError) {
        // Same reasoning as above: an unreachable provider must not erase an
        // answer we already have.
        if (cached && cached.bank_name && cached.branch_name) {
          return {
            code: 200,
            ifsc,
            bank_name: cached.bank_name,
            branch_name: cached.branch_name,
            cached: true,
            stale: true,
          };
        }
        // `err.message` is the client's own safe text, chosen from a fixed
        // list. No provider payload, header, token or stack reaches here.
        return {
          code: err.category === FAILURE.INVALID_REQUEST ? 422 : err.httpCode || 502,
          msg: err.message,
        };
      }
      throw err;
    }

    if (!result || result.exists === false) {
      // Deliberately not cached, and deliberately not written over a row that
      // already exists: a "no" is not reference data.
      return { code: 404, ifsc, msg: "Invalid IFSC — please check the code" };
    }

    await this.repo.upsert({
      ifsc,
      bank_name: result.bank_name,
      branch_name: result.branch_name,
    });

    return {
      code: 200,
      ifsc,
      bank_name: result.bank_name,
      branch_name: result.branch_name,
      cached: false,
    };
  }
}

module.exports = (repo, bankService, now) => new IfscLookupUsecase(repo, bankService, now);
module.exports.IfscLookupUsecase = IfscLookupUsecase;
module.exports.IFSC_PATTERN = IFSC_PATTERN;
module.exports.normalise = normalise;
