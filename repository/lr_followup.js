// repository/lr_followup.js
const logger = require("../utils/logger");
const { withTransaction } = require("../utils/transaction");
const { OPEN_STATUSES, STATUS, SOURCE_TYPE } = require("../utils/lr_followup");

/**
 * Storage for LR Follow-up: the follow-up rows, their append-only history,
 * and the reads the triggers and the backfill make of the two sources.
 *
 * Every method takes an optional `conn` as its last argument. Given one, it
 * runs on that connection - inside the caller's transaction; without one it
 * runs on the pool. Nothing here UPDATEs or DELETEs `lr_followup_activity`.
 */

/** Columns a caller may sort the dashboard by. */
const SORTABLE = {
  lr_followup_id: "f.lr_followup_id",
  source_date: "f.source_date",
  amount: "f.amount",
  expected_delivery_date: "f.expected_delivery_date",
  next_follow_up_date: "f.next_follow_up_date",
  last_follow_up_at: "f.last_follow_up_at",
  supplier_name: "distributor.mdm_dist_name",
  status: "f.status",
  ageing: "ageing_days",
};

/**
 * The derived figures, in SQL so the dashboard can filter and sort on them.
 * `?` is today's IST date, passed in rather than read from the database
 * clock, so the server's zone never decides what "overdue" means.
 */
const AGEING_SQL = `GREATEST(0, DATEDIFF(
    CASE WHEN f.status IN ('CLOSED','GOODS_RECEIVED')
         THEN COALESCE(DATE(f.goods_received_at), DATE(f.closed_at), ?)
         ELSE ? END,
    DATE(f.source_date)))`;
const OVERDUE_SQL = `(f.expected_delivery_date IS NOT NULL
    AND f.expected_delivery_date < ?
    AND f.status NOT IN ('CLOSED','GOODS_RECEIVED'))`;
const DAYS_OVERDUE_SQL = `CASE WHEN ${OVERDUE_SQL}
    THEN DATEDIFF(?, f.expected_delivery_date) ELSE 0 END`;

const SELECT = `
  f.*,
  distributor.mdm_dist_name AS supplier_name,
  outlets.outlet_name,
  transporter.transporter_name,
  transporter.contact_no    AS transporter_contact_no,
  transporter.is_active     AS transporter_is_active,
  receiver.employee_name    AS goods_received_by_name,
  closer.employee_name      AS closed_by_name,
  ${AGEING_SQL}             AS ageing_days,
  ${OVERDUE_SQL}            AS is_overdue,
  ${DAYS_OVERDUE_SQL}       AS days_overdue`;

/** The five `?` the derived columns above consume, in order. */
const selectParams = (today) => [today, today, today, today, today];

const JOINS = `
  FROM lr_followup f
  LEFT JOIN product_distributor_master AS distributor
         ON distributor.mdm_dist_code = f.distributor_code
  LEFT JOIN outlets                 ON outlets.outlet_id     = f.outlet_id
  LEFT JOIN transporter_master AS transporter
         ON transporter.transporter_id = f.transporter_id
  LEFT JOIN new_employee AS receiver ON receiver.employee_id = f.goods_received_by
  LEFT JOIN new_employee AS closer   ON closer.employee_id   = f.closed_by`;

/** `IN (?, ?, ...)` for a list. */
const placeholders = (list) => list.map(() => "?").join(", ");

class LrFollowupRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = [], conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.LR_FOLLOWUP",
            code: `REPOSITORY.LR_FOLLOWUP.${code}`,
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

  /**
   * The branch-scope predicate. `null` = every branch; `[]` = none, which
   * renders as a predicate nothing matches rather than as "no filter".
   */
  scopeClause(storeIds, column = "f.outlet_id") {
    if (storeIds === null || storeIds === undefined) return { clause: "", params: [] };
    if (storeIds.length === 0) return { clause: " AND 1 = 0", params: [] };
    return { clause: ` AND ${column} IN (${placeholders(storeIds)})`, params: [...storeIds] };
  }

  // ------------------------------------------------------------ one record

  getById(id, today, conn = null, { forUpdate = false } = {}) {
    // A locking read only needs the row itself; the joins are for display.
    if (forUpdate) {
      return this.run(
        "GETBYID.LOCK",
        `SELECT * FROM lr_followup WHERE lr_followup_id = ? FOR UPDATE`,
        [id],
        conn
      ).then((rows) => rows[0] || null);
    }
    return this.run(
      "GETBYID",
      `SELECT ${SELECT} ${JOINS} WHERE f.lr_followup_id = ?`,
      [...selectParams(today), id],
      conn
    ).then((rows) => rows[0] || null);
  }

  getBySource(sourceType, sourceId, today, conn = null, { forUpdate = false } = {}) {
    const column =
      sourceType === SOURCE_TYPE.ADVANCE_REQUEST ? "advance_request_id" : "credit_purchase_id";
    if (forUpdate) {
      return this.run(
        "GETBYSOURCE.LOCK",
        `SELECT * FROM lr_followup WHERE ${column} = ? FOR UPDATE`,
        [sourceId],
        conn
      ).then((rows) => rows[0] || null);
    }
    return this.run(
      "GETBYSOURCE",
      `SELECT ${SELECT} ${JOINS} WHERE f.${column} = ?`,
      [...selectParams(today), sourceId],
      conn
    ).then((rows) => rows[0] || null);
  }

  insert(row, conn = null) {
    const columns = Object.keys(row);
    return this.run(
      "INSERT",
      `INSERT INTO lr_followup (${columns.join(", ")}) VALUES (${placeholders(columns)})`,
      columns.map((c) => (row[c] === undefined ? null : row[c])),
      conn
    ).then((res) => res.insertId);
  }

  /**
   * Writes `fields`, but only while the row still holds `expectedStatus`.
   * Callers already hold the row lock; the status in the WHERE is the
   * second guard, so a stale caller changes nothing.
   */
  update(id, expectedStatus, fields, conn = null) {
    const columns = Object.keys(fields);
    return this.run(
      "UPDATE",
      `UPDATE lr_followup
          SET ${columns.map((c) => `${c} = ?`).join(", ")}
        WHERE lr_followup_id = ? AND status = ?`,
      [...columns.map((c) => (fields[c] === undefined ? null : fields[c])), id, expectedStatus],
      conn
    ).then((res) => res.affectedRows);
  }

  // --------------------------------------------------------------- history

  insertActivity(activity, conn = null) {
    return this.run(
      "ACTIVITY.INSERT",
      `INSERT INTO lr_followup_activity
         (lr_followup_id, activity_type, remark, old_status, new_status,
          next_follow_up_date, details, request_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activity.lr_followup_id,
        activity.activity_type,
        activity.remark ?? null,
        activity.old_status ?? null,
        activity.new_status ?? null,
        activity.next_follow_up_date ?? null,
        activity.details ? JSON.stringify(activity.details) : null,
        activity.request_key ?? null,
        activity.created_by ?? null,
      ],
      conn
    ).then((res) => res.insertId);
  }

  findActivityByRequestKey(followupId, requestKey, conn = null) {
    return this.run(
      "ACTIVITY.BYKEY",
      `SELECT lr_followup_activity_id FROM lr_followup_activity
        WHERE lr_followup_id = ? AND request_key = ?`,
      [followupId, requestKey],
      conn
    ).then((rows) => rows[0] || null);
  }

  getActivity(followupId, conn = null) {
    return this.run(
      "ACTIVITY.LIST",
      `SELECT a.*, e.employee_name AS created_by_name
         FROM lr_followup_activity a
         LEFT JOIN new_employee e ON e.employee_id = a.created_by
        WHERE a.lr_followup_id = ?
        ORDER BY a.created_at ASC, a.lr_followup_activity_id ASC`,
      [followupId],
      conn
    ).then((rows) =>
      rows.map((row) => {
        let details = null;
        if (row.details) {
          try {
            details = JSON.parse(row.details);
          } catch (e) {
            details = null;
          }
        }
        return { ...row, details };
      })
    );
  }

  // ------------------------------------------------------------- dashboard

  /**
   * The WHERE shared by list and count. `filters.status` takes a status, or
   * `OPEN` (the default worklist), `CLOSED_ALL` (anything closed) or `ALL`.
   */
  buildFilters(filters, storeIds, today) {
    let clause = " WHERE 1 = 1";
    const params = [];

    const status = filters.status || "OPEN";
    if (status === "OPEN") {
      clause += ` AND f.status IN (${placeholders(OPEN_STATUSES)})`;
      params.push(...OPEN_STATUSES);
    } else if (status !== "ALL") {
      clause += " AND f.status = ?";
      params.push(status);
    }

    if (filters.source_type) {
      clause += " AND f.source_type = ?";
      params.push(filters.source_type);
    }
    if (filters.distributor_code) {
      clause += " AND f.distributor_code = ?";
      params.push(filters.distributor_code);
    }
    // Reporting: stock actually received vs. resolved without receipt.
    if (filters.closure_reason === "WITHOUT_RECEIPT") {
      clause += " AND f.closure_reason IN ('REFUNDED','ADJUSTED','CANCELLED')";
    } else if (filters.closure_reason) {
      clause += " AND f.closure_reason = ?";
      params.push(filters.closure_reason);
    }
    if (filters.transporter_id) {
      clause += " AND f.transporter_id = ?";
      params.push(filters.transporter_id);
    }
    if (filters.from_date) {
      clause += " AND f.source_date >= ?";
      params.push(`${filters.from_date} 00:00:00`);
    }
    if (filters.to_date) {
      clause += " AND f.source_date <= ?";
      params.push(`${filters.to_date} 23:59:59`);
    }
    if (filters.overdue_only) {
      clause += ` AND ${OVERDUE_SQL}`;
      params.push(today);
    }
    if (filters.is_legacy !== undefined) {
      clause += " AND f.is_legacy = ?";
      params.push(filters.is_legacy ? 1 : 0);
    }
    if (filters.ageing_min !== undefined) {
      clause += ` AND ${AGEING_SQL} >= ?`;
      params.push(today, today, filters.ageing_min);
    }
    if (filters.ageing_max !== undefined && filters.ageing_max !== null) {
      clause += ` AND ${AGEING_SQL} <= ?`;
      params.push(today, today, filters.ageing_max);
    }
    if (filters.search) {
      const term = `%${filters.search}%`;
      clause += ` AND (f.lr_no LIKE ? OR f.invoice_number LIKE ? OR transporter.transporter_name LIKE ?
                       OR distributor.mdm_dist_name LIKE ?)`;
      params.push(term, term, term, term);
    }

    const scope = this.scopeClause(storeIds);
    clause += scope.clause;
    params.push(...scope.params);

    return { clause, params };
  }

  /**
   * Oldest and most overdue first unless asked otherwise: overdue rows lead,
   * the most days past expected delivery first, then the longest waiting.
   */
  buildOrderBy(sortBy, sortDir) {
    if (!sortBy || !SORTABLE[sortBy]) {
      return " ORDER BY is_overdue DESC, days_overdue DESC, f.source_date ASC, f.lr_followup_id ASC";
    }
    const direction = String(sortDir).toLowerCase() === "desc" ? "DESC" : "ASC";
    return ` ORDER BY ${SORTABLE[sortBy]} ${direction}, f.lr_followup_id ASC`;
  }

  list(filters, storeIds, today, limit, offset, sortBy, sortDir) {
    const { clause, params } = this.buildFilters(filters, storeIds, today);
    return this.run(
      "LIST",
      `SELECT ${SELECT} ${JOINS} ${clause} ${this.buildOrderBy(sortBy, sortDir)} LIMIT ? OFFSET ?`,
      [...selectParams(today), ...params, limit, offset]
    );
  }

  count(filters, storeIds, today) {
    const { clause, params } = this.buildFilters(filters, storeIds, today);
    return this.run("COUNT", `SELECT COUNT(*) AS count ${JOINS} ${clause}`, params).then(
      (rows) => Number(rows[0].count)
    );
  }

  /** The summary cards, in one pass over the follow-ups the caller may see. */
  summary(storeIds, today) {
    const scope = this.scopeClause(storeIds);
    const open = placeholders(OPEN_STATUSES);
    return this.run(
      "SUMMARY",
      `SELECT
         SUM(f.status IN (${open}))                                         AS total_open,
         SUM(f.status IN (${open}) AND f.source_type = 'ADVANCE_REQUEST')  AS advance_open,
         SUM(f.status IN (${open}) AND f.source_type = 'CREDIT_PURCHASE')  AS credit_open,
         SUM(f.status = 'DISPATCH_PENDING')                                 AS dispatch_pending,
         SUM(f.status = 'IN_TRANSIT')                                       AS in_transit,
         SUM(f.status IN (${open}) AND ${OVERDUE_SQL})                      AS overdue,
         COALESCE(SUM(CASE WHEN f.status IN (${open}) THEN f.amount END), 0) AS outstanding_amount,
         SUM(f.status = 'VERIFICATION_REQUIRED')                            AS verification_required,
         SUM(f.status IN (${open}) AND f.next_follow_up_date IS NOT NULL
             AND f.next_follow_up_date <= ?)                                AS follow_up_due,
         SUM(f.status = 'CLOSED' AND f.closure_reason = 'GOODS_RECEIVED')   AS closed_goods_received,
         SUM(f.status = 'CLOSED' AND f.closure_reason = 'REFUNDED')         AS closed_refunded,
         SUM(f.status = 'CLOSED' AND f.closure_reason = 'ADJUSTED')         AS closed_adjusted,
         SUM(f.status = 'CLOSED' AND f.closure_reason = 'CANCELLED')        AS closed_cancelled
       FROM lr_followup f
      WHERE 1 = 1 ${scope.clause}`,
      [
        ...OPEN_STATUSES,
        ...OPEN_STATUSES,
        ...OPEN_STATUSES,
        ...OPEN_STATUSES,
        today,
        ...OPEN_STATUSES,
        ...OPEN_STATUSES,
        today,
        ...scope.params,
      ]
    ).then((rows) => {
      const r = rows[0] || {};
      const n = (v) => Number(v || 0);
      return {
        total_open: n(r.total_open),
        advance_open: n(r.advance_open),
        credit_open: n(r.credit_open),
        dispatch_pending: n(r.dispatch_pending),
        in_transit: n(r.in_transit),
        overdue: n(r.overdue),
        outstanding_amount: Number(r.outstanding_amount || 0),
        verification_required: n(r.verification_required),
        follow_up_due: n(r.follow_up_due),
        closed_goods_received: n(r.closed_goods_received),
        closed_refunded: n(r.closed_refunded),
        closed_adjusted: n(r.closed_adjusted),
        closed_cancelled: n(r.closed_cancelled),
        closed_without_receipt: n(r.closed_refunded) + n(r.closed_adjusted) + n(r.closed_cancelled),
      };
    });
  }

  // ---------------------------------------------------------------- sources

  /**
   * The advance request as the trigger needs it. Read inside the payment's
   * transaction, after the status write, so it sees `paid`.
   */
  getAdvanceRequest(id, conn = null, { forUpdate = false } = {}) {
    return this.run(
      "SOURCE.ADVANCE",
      `SELECT ar.advance_request_id, ar.status, ar.distributor_code, ar.outlet_id,
              ar.amount, ar.paid_amount, ar.invoice_number, ar.paid_at,
              ar.payment_date, ar.updated_at, ar.created_at,
              payer.employee_name AS paid_by_name
         FROM advance_requests ar
         LEFT JOIN new_employee payer ON payer.employee_id = ar.paid_by
        WHERE ar.advance_request_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [id],
      conn
    ).then((rows) => rows[0] || null);
  }

  getCreditPurchase(id, conn = null, { forUpdate = false } = {}) {
    return this.run(
      "SOURCE.CREDIT",
      `SELECT cp.*, creator.employee_name AS created_by_name,
              t.transporter_name, t.contact_no AS transporter_contact_no
         FROM credit_purchases cp
         LEFT JOIN new_employee creator ON creator.employee_id = cp.created_by
         LEFT JOIN transporter_master t ON t.transporter_id = cp.transporter_id
        WHERE cp.credit_purchase_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [id],
      conn
    ).then((rows) => rows[0] || null);
  }

  /** Paid advances with no follow-up: the backfill's work, and an exception. */
  paidAdvancesWithoutFollowup(storeIds = null, conn = null) {
    const scope = this.scopeClause(storeIds, "ar.outlet_id");
    return this.run(
      "SOURCE.ADVANCE.MISSING",
      `SELECT ar.advance_request_id
         FROM advance_requests ar
         LEFT JOIN lr_followup f ON f.advance_request_id = ar.advance_request_id
        WHERE ar.status = 'paid' AND f.lr_followup_id IS NULL ${scope.clause}
        ORDER BY ar.advance_request_id ASC`,
      scope.params,
      conn
    ).then((rows) => rows.map((r) => Number(r.advance_request_id)));
  }

  creditPurchasesWithoutFollowup(storeIds = null, conn = null) {
    const scope = this.scopeClause(storeIds, "cp.outlet_id");
    return this.run(
      "SOURCE.CREDIT.MISSING",
      `SELECT cp.credit_purchase_id
         FROM credit_purchases cp
         LEFT JOIN lr_followup f ON f.credit_purchase_id = cp.credit_purchase_id
        WHERE f.lr_followup_id IS NULL ${scope.clause}
        ORDER BY cp.credit_purchase_id ASC`,
      scope.params,
      conn
    ).then((rows) => rows.map((r) => Number(r.credit_purchase_id)));
  }
}

LrFollowupRepository.STATUS = STATUS;

module.exports = (db) => new LrFollowupRepository(db);
