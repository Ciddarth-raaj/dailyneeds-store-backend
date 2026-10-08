// repository/lr_followup_manual.js
const logger = require("../utils/logger");
const { withTransaction } = require("../utils/transaction");

/**
 * The manual LR Follow-up entries ("Create LR Follow-up"). They live in the
 * `credit_purchases` table, the name the entry shipped with; the table is
 * kept rather than renamed. Rows are never updated or deleted here: the
 * follow-up is where dispatch details are kept current.
 */

class LrFollowupManualRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = [], conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.LR_FOLLOWUP_MANUAL",
            code: `REPOSITORY.LR_FOLLOWUP_MANUAL.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  transaction(work) {
    return withTransaction(this.db, work);
  }

  insert(entry, conn = null) {
    return this.run(
      "INSERT",
      `INSERT INTO credit_purchases
         (distributor_code, outlet_id, transporter_id, lr_no, dispatch_date,
          expected_delivery_date, remarks, request_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.distributor_code,
        entry.outlet_id,
        entry.transporter_id,
        entry.lr_no ?? null,
        entry.dispatch_date ?? null,
        entry.expected_delivery_date ?? null,
        entry.remarks ?? null,
        entry.request_key ?? null,
        entry.created_by,
      ],
      conn
    ).then((res) => res.insertId);
  }

  findByRequestKey(requestKey, conn = null) {
    return this.run(
      "BYKEY",
      // A plain read, not a locking one: a gap lock here would deadlock two
      // retries of the same submission. The unique key on request_key
      // decides the race, and the loser answers with the winner's row.
      `SELECT credit_purchase_id FROM credit_purchases WHERE request_key = ?`,
      [requestKey],
      conn
    ).then((rows) => (rows[0] ? Number(rows[0].credit_purchase_id) : null));
  }

  /** The follow-up created with this entry. */
  followupIdOf(entryId, conn = null) {
    return this.run(
      "FOLLOWUP",
      `SELECT lr_followup_id FROM lr_followup WHERE credit_purchase_id = ?`,
      [entryId],
      conn
    ).then((rows) => (rows[0] ? Number(rows[0].lr_followup_id) : null));
  }
}

module.exports = (db) => new LrFollowupManualRepository(db);
