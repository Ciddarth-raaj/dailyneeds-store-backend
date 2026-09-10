const logger = require("../utils/logger");

/**
 * Stage 0C / C2 — the local IFSC master.
 *
 * A cache of public reference data: which bank and which branch a given IFSC
 * belongs to. It holds no employee data at all, which is why it is a table of
 * its own rather than more columns on `new_employee` - the same branch code
 * serves every employee who banks there, and storing it per employee would be
 * storing one fact many times and paying the provider for each copy.
 *
 * The IFSC arrives here already normalised. That is deliberate: normalising in
 * one place - the usecase - and requiring it here means the primary key cannot
 * be reached by two spellings of the same code.
 */
class IfscMasterRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.IFSC_MASTER",
      code: `REPOSITORY.IFSC_MASTER.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err, { ...(params && params[0] ? { ifsc: params[0] } : {}) });
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /** One cached IFSC, or null. `last_checked_at` decides whether it is usable. */
  async get(ifsc) {
    const rows = await this._query(
      "GET",
      `SELECT ifsc, bank_name, branch_name, last_checked_at
         FROM ifsc_master WHERE ifsc = ?`,
      [ifsc]
    );
    return rows[0] || null;
  }

  /**
   * Records what the provider said about an IFSC.
   *
   * `ON DUPLICATE KEY UPDATE` rather than a select-then-insert, so two
   * lookups of the same new IFSC arriving together cannot produce two rows or
   * a duplicate-key error: the primary key arbitrates and the second becomes
   * an update. A refreshed row always moves `last_checked_at` forward, even
   * when the names came back identical, because the point of the timestamp is
   * when we last ASKED - not when the answer last changed.
   */
  async upsert({ ifsc, bank_name, branch_name }) {
    await this._query(
      "UPSERT",
      `INSERT INTO ifsc_master (ifsc, bank_name, branch_name, last_checked_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
            bank_name = VALUES(bank_name),
            branch_name = VALUES(branch_name),
            last_checked_at = CURRENT_TIMESTAMP`,
      [ifsc, bank_name, branch_name]
    );
    return { ifsc, bank_name, branch_name };
  }
}

module.exports = (db) => new IfscMasterRepository(db);
module.exports.IfscMasterRepository = IfscMasterRepository;
