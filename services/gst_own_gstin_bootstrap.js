const logger = require("../utils/logger");
const {
  readTaxpayerRegistration,
  readLegalName,
  maskGstin,
} = require("../config/gst_taxpayer");

/**
 * Put the environment's GST registration into the database, once per boot.
 *
 * THE ENVIRONMENT IS THE SOURCE OF TRUTH: env -> bootstrap -> database. The
 * table is persisted configuration and audit state, never the authority. With
 * no valid environment configuration there is NO registration, whatever the
 * table happens to hold.
 *
 * MIGRATION IS STRUCTURE, THIS IS DATA. `20261029120000-gst-own-gstin`
 * creates an empty table; the company's GSTIN and portal username arrive
 * here, from the environment, at runtime. That split is what keeps the
 * identifiers out of git.
 *
 * IDEMPOTENT, and that matters more than it looks: this runs on every
 * restart, and a restart must not invalidate a live taxpayer session. An
 * unchanged environment yields the same `own_gstin_id`, the session stays
 * bound to it, and nobody is asked for an OTP because pm2 reloaded.
 *
 * IT NEVER THROWS INTO BOOT. Unconfigured, or a database that will not take
 * the row, leaves `configured: false` and the server carries on. The refusal
 * happens at the point of use - `GSTAuthentication` cannot obtain a
 * registration, so taxpayer-authenticated GST calls fail closed with a
 * configuration error while attendance, payroll and everything else run
 * normally.
 */
class GstOwnGstinBootstrap {
  /** @param {{ gstOwnGstinRepo: object, env?: object }} deps */
  constructor({ gstOwnGstinRepo, env = process.env }) {
    this.gstOwnGstinRepo = gstOwnGstinRepo;
    this.env = env;
    /** @type {null | { own_gstin_id: number, gstin: string, portal_username: string }} */
    this._registration = null;
    /** @type {null | string} why there is no registration, for the error payload */
    this._reason = null;
  }

  /**
   * @returns {Promise<{ configured: boolean, created?: boolean, reason?: string }>}
   */
  async run() {
    const cfg = readTaxpayerRegistration(this.env);

    if (!cfg.ok) {
      this._registration = null;
      this._reason = cfg.reason;
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "SERVICE.GST_OWN_GSTIN",
        code: "SERVICE.GST_OWN_GSTIN.NOT-CONFIGURED",
        // cfg.reason names variables and shapes, never values.
        description: `${cfg.reason}; GST taxpayer operations will refuse until it is set.`,
        category: "",
        ref: {},
      });
      // NO DATABASE FALLBACK, deliberately.
      //
      // An earlier draft read the stored row here so a server started without
      // the variables "kept working". That inverts the authority: the
      // environment configures this server, the table records what the
      // environment said. Reading the row back when the environment is absent
      // or invalid makes yesterday's registration the authority, and the case
      // that matters is a TYPO - one wrong character in GST_OWN_GSTIN would
      // have silently carried on filing against the previous registration
      // instead of failing where somebody would see it.
      //
      // The row is NOT deleted. It stays as configuration/audit state and
      // becomes usable again the moment valid environment values return.
      return { configured: false, reason: cfg.reason };
    }

    try {
      const row = await this.gstOwnGstinRepo.upsertFromConfig({
        gstin: cfg.gstin,
        portalUsername: cfg.portalUsername,
        legalName: readLegalName(this.env),
      });
      this._registration = row;
      this._reason = null;
      logger.Log({
        level: logger.LEVEL.INFO,
        component: "SERVICE.GST_OWN_GSTIN",
        code: "SERVICE.GST_OWN_GSTIN.CONFIGURED",
        description: `GST registration ${maskGstin(row.gstin)} active (id ${row.own_gstin_id}).`,
        category: "",
        ref: {},
      });
      return { configured: true, created: Boolean(row.created) };
    } catch (err) {
      this._registration = null;
      this._reason =
        "GST taxpayer registration could not be loaded from the database";
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE.GST_OWN_GSTIN",
        code: "SERVICE.GST_OWN_GSTIN.BOOTSTRAP-FAILED",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return { configured: false, reason: this._reason };
    }
  }

  /** The active registration, or null. Never throws. */
  getRegistration() {
    return this._registration;
  }

  /** Why there is none, for a 503 payload. */
  getUnconfiguredReason() {
    return this._reason;
  }

  isConfigured() {
    return this._registration !== null;
  }
}

module.exports = (deps) => new GstOwnGstinBootstrap(deps);
module.exports.GstOwnGstinBootstrap = GstOwnGstinBootstrap;
