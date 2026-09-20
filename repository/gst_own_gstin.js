const logger = require("../utils/logger");

const TABLE = "gst_own_gstin";

function mapRow(row) {
  if (!row) return null;
  return {
    own_gstin_id: Number(row.own_gstin_id),
    gstin: row.gstin,
    legal_name: row.legal_name,
    portal_username: row.portal_username,
    is_active: Number(row.is_active) === 1,
    is_default: Number(row.is_default) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The GST registration this server files for.
 *
 * ONE ACTIVE ROW is all this phase reads. The table can hold more so that a
 * second GSTIN is a row rather than a schema change, but nothing here
 * chooses between several: `getActive()` returns the active default, and
 * `upsertFromConfig` is what the boot-time bootstrap calls.
 */
class GstOwnGstinRepository {
  constructor(db) {
    this.db = db;
  }

  _query(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  /** The configured registration, or null when nobody has configured one. */
  async getActive() {
    try {
      const rows = await this._query(
        `SELECT own_gstin_id, gstin, legal_name, portal_username, is_active, is_default, created_at, updated_at
         FROM ${TABLE}
         WHERE is_active = 1
         ORDER BY is_default DESC, own_gstin_id ASC
         LIMIT 1`,
        [],
      );
      return mapRow(rows && rows[0]);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.GST_OWN_GSTIN",
        code: "REPOSITORY.GST_OWN_GSTIN.GET_ACTIVE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getByGstin(gstin) {
    const rows = await this._query(
      `SELECT own_gstin_id, gstin, legal_name, portal_username, is_active, is_default, created_at, updated_at
       FROM ${TABLE} WHERE gstin = ? LIMIT 1`,
      [String(gstin).trim().toUpperCase()],
    );
    return mapRow(rows && rows[0]);
  }

  /**
   * Make the environment's registration the one active row, and return it.
   *
   * IDEMPOTENT. Called on every boot. An unchanged environment produces an
   * unchanged row - the same `own_gstin_id`, so the taxpayer session stays
   * bound and nobody is asked for an OTP because the server restarted.
   *
   * A CHANGED GSTIN IS A DIFFERENT ROW, deliberately. The old registration is
   * deactivated rather than rewritten, which is what makes the session
   * binding in `sandbox_gst_taxpayer_session.own_gstin_id` mean something:
   * the stored JWT still points at the row it was minted for, that row is no
   * longer active, and the mismatch check refuses it. Rewriting the GSTIN in
   * place would silently re-point a live token at a different registration.
   *
   * @param {{ gstin: string, portalUsername: string, legalName?: string|null }} cfg
   */
  async upsertFromConfig({ gstin, portalUsername, legalName = null }) {
    const normalized = String(gstin).trim().toUpperCase();
    const username = String(portalUsername).trim();

    try {
      // Same GSTIN: refresh the mutable fields, keep the id.
      const existing = await this.getByGstin(normalized);
      if (existing) {
        await this._query(
          `UPDATE ${TABLE}
           SET portal_username = ?, legal_name = ?, is_active = 1, is_default = 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE own_gstin_id = ?`,
          [username, legalName, existing.own_gstin_id],
        );
        await this._deactivateOthers(existing.own_gstin_id);
        return { ...(await this.getByGstin(normalized)), created: false };
      }

      const result = await new Promise((resolve, reject) => {
        this.db.query(
          `INSERT INTO ${TABLE} (gstin, legal_name, portal_username, is_active, is_default)
           VALUES (?, ?, ?, 1, 1)`,
          [normalized, legalName, username],
          (err, res) => (err ? reject(err) : resolve(res)),
        );
      });
      await this._deactivateOthers(result.insertId);
      return { ...(await this.getByGstin(normalized)), created: true };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.GST_OWN_GSTIN",
        code: "REPOSITORY.GST_OWN_GSTIN.UPSERT",
        description: err.toString(),
        category: "",
        // No GSTIN and no username in the log reference.
        ref: {},
      });
      throw err;
    }
  }

  /** Exactly one active default at a time. */
  _deactivateOthers(keepId) {
    return this._query(
      `UPDATE ${TABLE}
       SET is_active = 0, is_default = 0, updated_at = CURRENT_TIMESTAMP
       WHERE own_gstin_id <> ?`,
      [keepId],
    );
  }
}

module.exports = (db) => new GstOwnGstinRepository(db);
module.exports.GstOwnGstinRepository = GstOwnGstinRepository;
