// repository/advance_request.js
const logger = require("../utils/logger");

/** Columns a caller is allowed to sort the list by. */
const SORTABLE = {
  advance_request_id: "advance_requests.advance_request_id",
  invoice_number: "advance_requests.invoice_number",
  amount: "advance_requests.amount",
  status: "advance_requests.status",
  created_at: "advance_requests.created_at",
  updated_at: "advance_requests.updated_at",
};

/**
 * Status order for "furthest along last" sorting. The enum is declared in
 * workflow order, but ORDER BY on an ENUM sorts by declaration index, which
 * is only the same thing by coincidence - spell it out so it stays true if a
 * status is ever inserted in the middle.
 */
const STATUS_RANK = `FIELD(advance_requests.status,
  'submitted', 'pending_purchase_decision', 'pending_approval', 'on_hold',
  'approved', 'rejected', 'paid')`;

const ITEM_SELECT = `
  advance_requests.*,
  distributor.mdm_dist_name AS supplier_name,
  distributor.cid           AS supplier_cid,
  bank.name                 AS bank_name,
  outlets.outlet_name,
  creator.employee_name     AS created_by_name,
  checker.employee_name     AS balance_checked_by_name,
  approver.employee_name    AS approved_by_name,
  payer.employee_name       AS paid_by_name`;

const ITEM_JOINS = `
  FROM advance_requests
  LEFT JOIN product_distributor_master AS distributor
         ON distributor.mdm_dist_code = advance_requests.distributor_code
  LEFT JOIN people_list AS bank       ON bank.person_id       = advance_requests.bank_id
  LEFT JOIN outlets                   ON outlets.outlet_id    = advance_requests.outlet_id
  LEFT JOIN new_employee AS creator   ON creator.employee_id  = advance_requests.created_by
  LEFT JOIN new_employee AS checker   ON checker.employee_id  = advance_requests.balance_checked_by
  LEFT JOIN new_employee AS approver  ON approver.employee_id = advance_requests.approved_by
  LEFT JOIN new_employee AS payer     ON payer.employee_id    = advance_requests.paid_by`;

class AdvanceRequestRepository {
  constructor(db) {
    this.db = db;
  }

  /** Runs a query, logging failures the same way across every method. */
  run(code, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.ADVANCE_REQUEST",
            code: `REPOSITORY.ADVANCE_REQUEST.${code}`,
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

  /**
   * Builds the shared WHERE clause for list and count so the two can never
   * drift.
   */
  buildFilters(filters = {}) {
    let clause = " WHERE 1 = 1";
    const params = [];

    const eq = (column, value) => {
      if (value === undefined || value === null || value === "") return;
      clause += ` AND ${column} = ?`;
      params.push(value);
    };

    eq("advance_requests.status", filters.status);
    eq("advance_requests.distributor_code", filters.distributor_code);
    eq("advance_requests.outlet_id", filters.outlet_id);
    eq("advance_requests.created_by", filters.created_by);
    eq("advance_requests.invoice_number", filters.invoice_number);

    // "Anything still moving" - the default worklist. Rejected and paid are
    // the two terminal statuses.
    if (filters.is_open) {
      clause += ` AND advance_requests.status NOT IN ('rejected', 'paid')`;
    }

    if (filters.search) {
      clause += ` AND (advance_requests.invoice_number LIKE ?
                       OR distributor.mdm_dist_name LIKE ?
                       OR advance_requests.reason LIKE ?)`;
      const term = `%${filters.search}%`;
      params.push(term, term, term);
    }

    return { clause, params };
  }

  buildOrderBy(sortBy, sortDir) {
    const direction = String(sortDir).toLowerCase() === "asc" ? "ASC" : "DESC";

    if (sortBy === "status") {
      return ` ORDER BY ${STATUS_RANK} ${direction}`;
    }

    const column = SORTABLE[sortBy] || "advance_requests.created_at";
    return ` ORDER BY ${column} ${direction}`;
  }

  create(request) {
    return this.run(
      "CREATE",
      `INSERT INTO advance_requests
         (invoice_number, distributor_code, amount, reason, outlet_id,
          status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, NOW(), NOW())`,
      [
        request.invoice_number ?? null,
        request.distributor_code,
        request.amount,
        request.reason ?? null,
        request.outlet_id ?? null,
        request.created_by,
      ]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getAll(filters, limit, offset, sortBy, sortDir) {
    const { clause, params } = this.buildFilters(filters);

    // Document count is aggregated in SQL so the list never needs a
    // follow-up query per row.
    const sql = `
      SELECT ${ITEM_SELECT},
        (SELECT COUNT(*) FROM advance_request_documents d
          WHERE d.advance_request_id = advance_requests.advance_request_id)
          AS document_count
      ${ITEM_JOINS}
      ${clause}
      ${this.buildOrderBy(sortBy, sortDir)}
      LIMIT ? OFFSET ?`;

    return this.run("GETALL", sql, [...params, limit, offset]);
  }

  getCount(filters) {
    const { clause, params } = this.buildFilters(filters);
    return this.run(
      "GETCOUNT",
      `SELECT COUNT(*) AS count ${ITEM_JOINS} ${clause}`,
      params
    ).then((docs) => docs[0].count);
  }

  getById(id) {
    return this.run(
      "GETBYID",
      `SELECT ${ITEM_SELECT} ${ITEM_JOINS}
        WHERE advance_requests.advance_request_id = ?`,
      [id]
    ).then((docs) => (docs.length > 0 ? docs[0] : null));
  }

  /**
   * Applies a stage's fields and its new status in one statement, but only
   * while the row still holds the status the caller acted on.
   *
   * The status is part of the WHERE rather than checked beforehand: two
   * approvers hitting Approve at the same moment would both pass a prior
   * read, and the second write would silently overwrite the first. Here the
   * second matches no rows, and the usecase turns that into a 409.
   */
  updateStage(id, expectedStatus, nextStatus, fields) {
    const assignments = ["status = ?"];
    const params = [nextStatus];

    Object.keys(fields).forEach((column) => {
      assignments.push(`${column} = ?`);
      params.push(fields[column] === undefined ? null : fields[column]);
    });

    assignments.push("updated_at = NOW()");

    return this.run(
      "UPDATESTAGE",
      `UPDATE advance_requests
          SET ${assignments.join(", ")}
        WHERE advance_request_id = ? AND status = ?`,
      [...params, id, expectedStatus]
    ).then((res) => ({ code: 200, affectedRows: res.affectedRows }));
  }

  // -------------------------------------------------------------- documents

  createDocument(requestId, stage, fileUrl, uploadedBy) {
    return this.run(
      "DOCUMENT.CREATE",
      `INSERT INTO advance_request_documents
         (advance_request_id, stage, file_url, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [requestId, stage, fileUrl, uploadedBy ?? null]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getDocumentsByRequestId(requestId) {
    return this.run(
      "DOCUMENT.GETBYREQUESTID",
      `SELECT d.*, e.employee_name AS uploaded_by_name
         FROM advance_request_documents d
         LEFT JOIN new_employee e ON e.employee_id = d.uploaded_by
        WHERE d.advance_request_id = ?
        ORDER BY d.created_at ASC`,
      [requestId]
    );
  }

  // --------------------------------------------------------------- activity

  createActivity(requestId, employeeId, field, oldValue, newValue) {
    return this.run(
      "ACTIVITY.CREATE",
      `INSERT INTO advance_request_activity
         (advance_request_id, employee_id, field, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        requestId,
        employeeId ?? null,
        field,
        oldValue === null || oldValue === undefined ? null : String(oldValue),
        newValue === null || newValue === undefined ? null : String(newValue),
      ]
    ).then((res) => ({ code: 200, id: res.insertId }));
  }

  getActivityByRequestId(requestId) {
    return this.run(
      "ACTIVITY.GETBYREQUESTID",
      `SELECT a.*, e.employee_name
         FROM advance_request_activity a
         LEFT JOIN new_employee e ON e.employee_id = a.employee_id
        WHERE a.advance_request_id = ?
        ORDER BY a.created_at ASC`,
      [requestId]
    );
  }
}

module.exports = (db) => {
  return new AdvanceRequestRepository(db);
};
