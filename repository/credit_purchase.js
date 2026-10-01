// repository/credit_purchase.js
const logger = require("../utils/logger");
const { withTransaction } = require("../utils/transaction");

/**
 * Credit purchases raised in dnds - the minimal entry for goods bought on
 * credit, which the LR Follow-up then tracks until they arrive. Rows are
 * never updated or deleted here: the follow-up is where dispatch details are
 * kept current, and a mistaken purchase is closed out through it.
 */

const SELECT = `
  cp.*,
  distributor.mdm_dist_name AS supplier_name,
  outlets.outlet_name,
  transporter.transporter_name,
  transporter.contact_no    AS transporter_contact_no,
  transporter.is_active     AS transporter_is_active,
  creator.employee_name     AS created_by_name,
  f.lr_followup_id,
  f.status                  AS followup_status,
  f.expected_delivery_date  AS followup_expected_delivery_date,
  f.closure_reason          AS followup_closure_reason`;

const JOINS = `
  FROM credit_purchases cp
  LEFT JOIN product_distributor_master AS distributor
         ON distributor.mdm_dist_code = cp.distributor_code
  LEFT JOIN outlets                ON outlets.outlet_id    = cp.outlet_id
  LEFT JOIN transporter_master AS transporter
         ON transporter.transporter_id = cp.transporter_id
  LEFT JOIN new_employee AS creator ON creator.employee_id = cp.created_by
  LEFT JOIN lr_followup f          ON f.credit_purchase_id = cp.credit_purchase_id`;

class CreditPurchaseRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = [], conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.CREDIT_PURCHASE",
            code: `REPOSITORY.CREDIT_PURCHASE.${code}`,
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

  insert(purchase, conn = null) {
    return this.run(
      "INSERT",
      `INSERT INTO credit_purchases
         (distributor_code, bill_reference, bill_reference_key, amount, bill_date,
          outlet_id, transporter_id, lr_no, dispatch_date, expected_delivery_date,
          remarks, request_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchase.distributor_code,
        purchase.bill_reference,
        purchase.bill_reference_key,
        purchase.amount,
        purchase.bill_date,
        purchase.outlet_id,
        purchase.transporter_id,
        purchase.lr_no ?? null,
        purchase.dispatch_date ?? null,
        purchase.expected_delivery_date ?? null,
        purchase.remarks ?? null,
        purchase.request_key ?? null,
        purchase.created_by,
      ],
      conn
    ).then((res) => res.insertId);
  }

  /** The purchase already raised for this supplier bill (normalised key), if any. */
  findBySupplierBill(distributorCode, billReferenceKey, conn = null) {
    return this.run(
      "BYBILL",
      `SELECT credit_purchase_id FROM credit_purchases
        WHERE distributor_code = ? AND bill_reference_key = ?`,
      [distributorCode, billReferenceKey],
      conn
    ).then((rows) => (rows[0] ? Number(rows[0].credit_purchase_id) : null));
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

  getById(id, conn = null) {
    return this.run(
      "GETBYID",
      `SELECT ${SELECT} ${JOINS} WHERE cp.credit_purchase_id = ?`,
      [id],
      conn
    ).then((rows) => rows[0] || null);
  }

  buildFilters(filters, storeIds) {
    let clause = " WHERE 1 = 1";
    const params = [];
    if (filters.distributor_code) {
      clause += " AND cp.distributor_code = ?";
      params.push(filters.distributor_code);
    }
    if (filters.from_date) {
      clause += " AND cp.bill_date >= ?";
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      clause += " AND cp.bill_date <= ?";
      params.push(filters.to_date);
    }
    if (filters.search) {
      const term = `%${filters.search}%`;
      clause += " AND (cp.bill_reference LIKE ? OR distributor.mdm_dist_name LIKE ?)";
      params.push(term, term);
    }
    if (storeIds !== null && storeIds !== undefined) {
      if (storeIds.length === 0) {
        clause += " AND 1 = 0";
      } else {
        clause += ` AND cp.outlet_id IN (${storeIds.map(() => "?").join(", ")})`;
        params.push(...storeIds);
      }
    }
    return { clause, params };
  }

  list(filters, storeIds, limit, offset) {
    const { clause, params } = this.buildFilters(filters, storeIds);
    return this.run(
      "LIST",
      `SELECT ${SELECT} ${JOINS} ${clause}
        ORDER BY cp.bill_date DESC, cp.credit_purchase_id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
  }

  count(filters, storeIds) {
    const { clause, params } = this.buildFilters(filters, storeIds);
    return this.run("COUNT", `SELECT COUNT(*) AS count ${JOINS} ${clause}`, params).then((rows) =>
      Number(rows[0].count)
    );
  }
}

module.exports = (db) => new CreditPurchaseRepository(db);
