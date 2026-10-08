/**
 * HISTORICAL OT REVIEW - the reads behind the preview, and the review's own
 * audit writes.
 *
 * THE READ (`listCandidates`) touches nothing. THE WRITES touch only the
 * review's three tables (migration 20261128120000) and the employee's
 * `attendance_ot_deferred_sync` marker for an authorised date - the existing
 * mechanism that lets the OT sync raise a Pending OT request on a date before
 * the automatic-OT cutover, or in a locked month. The OT request itself is
 * created by `usecase/attendance_regularization.js#syncAutoOt`, through the
 * ordinary `createRequest`, which re-proves the marker under its row locks.
 * Nothing here approves, prices, pays, or writes a payroll row.
 */
const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { JOINED_ON } = require("../utils/joining_date");
const { CORRECTION_REQUEST_TYPES } = require("../utils/ot_correction_priority");

/** The review's own tables (migration 20261128120000). */
const REVIEW_TABLES = Object.freeze([
  "attendance_ot_historical_review_batch",
  "attendance_ot_historical_review_item",
  "attendance_ot_historical_review_raised",
]);

/** The deferred-marker source a review writes; see LOCKED_EXCEPTION_SOURCES. */
const REVIEW_MARKER_SOURCE = "HISTORICAL_REVIEW";

class AttendanceOtHistoricalReviewRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_OT_HISTORICAL_REVIEW",
      code: `REPOSITORY.ATTENDANCE_OT_HISTORICAL_REVIEW.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  async _read(code, sql, params) {
    try {
      return await queryAsync(this.db, sql, params);
    } catch (err) {
      this._log(code, err);
      throw err;
    }
  }

  /** The automatic-OT cutover row, or null. */
  async getAutoOtSetting() {
    const rows = await this._read(
      "GET-AUTO-OT-SETTING",
      `SELECT enabled, DATE_FORMAT(auto_pending_from_date, '%Y-%m-%d') AS auto_pending_from_date
         FROM attendance_ot_auto_pending_setting WHERE setting_id = 1`,
      []
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * IS THE REVIEW INSTALLED? One read of `information_schema` (a SELECT, so
   * it runs on the read-only handle too) for the review's own three tables
   * (migration 20261128120000). Before that migration the feature has never
   * run, so there is no review history to find: the preview treats "already
   * reviewed" as absent, and `authorise` refuses outright. A failed lookup is
   * an error, never "absent" - the never-twice check is not skipped on a
   * guess. Only the REVIEW's tables are optional: the settlement, deferred
   * marker and request tables every existing OT check reads must exist.
   */
  async reviewSchema() {
    const rows = await this._read(
      "REVIEW-SCHEMA",
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
      [REVIEW_TABLES]
    );
    const present = new Set((rows || []).map((r) => String(r.name || r.TABLE_NAME)));
    return {
      installed: REVIEW_TABLES.every((t) => present.has(t)),
      raised_table: present.has("attendance_ot_historical_review_raised"),
      present: REVIEW_TABLES.filter((t) => present.has(t)),
    };
  }

  /**
   * EVERY STORED DAY IN THE WINDOW WITH CALCULATED OT, with everything the
   * rule needs to classify it: the day's own figures and settlement, the
   * latest live OT request (and any withdrawn one), a Prior-Month OT
   * settlement, a pending attendance correction, the deferred marker, whether
   * a review already raised OT on it, the employment period, and the payroll
   * status of its month. ONE statement, read only.
   */
  async listCandidates({ from_date, to_date, employee_id = null, schema = null }) {
    const review = schema || (await this.reviewSchema());
    // THE NEVER-TWICE CHECK whenever its table exists; only a database that
    // has never had the review installed reads it as "not reviewed".
    const alreadyReviewed = review.raised_table
      ? `EXISTS (SELECT 1 FROM attendance_ot_historical_review_raised h
                  WHERE h.employee_id = c.employee_id AND h.attendance_date = c.attendance_date)`
      : "0";
    return this._read(
      "LIST-CANDIDATES",
      `SELECT c.employee_id, ne.employee_name,
              DATE_FORMAT(c.attendance_date, '%Y-%m-%d') AS attendance_date,
              c.status, c.is_final, c.punch_count,
              c.candidate_ot_minutes, COALESCE(c.shift_authorised_ot_minutes, 0) AS shift_authorised_ot_minutes,
              c.approved_ot_minutes,
              (SELECT r.attendance_approval_request_id FROM attendance_approval_request r
                WHERE r.requested_for_employee_id = c.employee_id AND r.attendance_date = c.attendance_date
                  AND r.request_type IN ('OT', 'REGULARIZATION_WITH_OT') AND r.status <> 'CANCELLED'
                ORDER BY r.attendance_approval_request_id DESC LIMIT 1) AS ot_request_id,
              (SELECT r.status FROM attendance_approval_request r
                WHERE r.requested_for_employee_id = c.employee_id AND r.attendance_date = c.attendance_date
                  AND r.request_type IN ('OT', 'REGULARIZATION_WITH_OT') AND r.status <> 'CANCELLED'
                ORDER BY r.attendance_approval_request_id DESC LIMIT 1) AS ot_request_status,
              (SELECT r.closure_reason FROM attendance_approval_request r
                WHERE r.requested_for_employee_id = c.employee_id AND r.attendance_date = c.attendance_date
                  AND r.request_type IN ('OT', 'REGULARIZATION_WITH_OT') AND r.status <> 'CANCELLED'
                ORDER BY r.attendance_approval_request_id DESC LIMIT 1) AS ot_request_closure_reason,
              (SELECT r.attendance_approval_request_id FROM attendance_approval_request r
                WHERE r.requested_for_employee_id = c.employee_id AND r.attendance_date = c.attendance_date
                  AND r.request_type = 'OT' AND r.status = 'CANCELLED'
                ORDER BY r.attendance_approval_request_id DESC LIMIT 1) AS withdrawn_request_id,
              (SELECT ls.settlement_status FROM attendance_ot_late_settlement ls
                WHERE ls.employee_id = c.employee_id AND ls.attendance_date = c.attendance_date
                  AND ls.settlement_status <> 'CANCELLED'
                ORDER BY ls.late_settlement_id DESC LIMIT 1) AS late_settlement_status,
              EXISTS (SELECT 1 FROM attendance_approval_request r
                       WHERE r.requested_for_employee_id = c.employee_id AND r.attendance_date = c.attendance_date
                         AND r.status = 'PENDING' AND r.request_type IN (?)) AS correction_pending,
              m.status AS marker_status, m.source AS marker_source,
              ${alreadyReviewed} AS already_reviewed,
              (((${JOINED_ON("ne")}) IS NOT NULL AND c.attendance_date < (${JOINED_ON("ne")}))
                OR (ne.resignation_date IS NOT NULL AND c.attendance_date > ne.resignation_date)) AS outside_employment,
              p.payrun_calculation_id AS payroll_calculation_id, p.status AS payroll_status,
              DATE_FORMAT(p.published_at, '%Y-%m-%d %H:%i:%s') AS payroll_published_at
         FROM attendance_day_calculation c
         JOIN new_employee ne ON ne.employee_id = c.employee_id
         LEFT JOIN attendance_ot_deferred_sync m
                ON m.employee_id = c.employee_id AND m.attendance_date = c.attendance_date
         LEFT JOIN payrun_employee_calculation p
                ON p.employee_id = c.employee_id
               AND p.period_year = YEAR(c.attendance_date) AND p.period_month = MONTH(c.attendance_date)
        WHERE c.attendance_date BETWEEN ? AND ?
          AND c.candidate_ot_minutes > 0
          AND (? IS NULL OR c.employee_id = ?)
        ORDER BY c.attendance_date, ne.employee_name, c.employee_id`,
      [CORRECTION_REQUEST_TYPES, from_date, to_date, employee_id, employee_id]
    );
  }

  /** The batch and its items, AUTHORISED, in one transaction. Returns the batch id. */
  async createBatch({ from_date, to_date, preview_hash, actor, items, note = null }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const batch = await queryAsync(
        conn,
        `INSERT INTO attendance_ot_historical_review_batch
           (from_date, to_date, preview_hash, item_count, authorised_by_employee_id, authorised_by_user_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [from_date, to_date, preview_hash, items.length, actor.employee_id, actor.user_id === undefined ? null : actor.user_id, note]
      );
      const batchId = Number(batch.insertId);
      if (items.length > 0) {
        await queryAsync(
          conn,
          `INSERT INTO attendance_ot_historical_review_item
             (review_batch_id, employee_id, attendance_date, calculated_ot_minutes, payroll_status,
              payroll_calculation_id, proposed_action)
           VALUES ?`,
          [items.map((i) => [batchId, i.employee_id, i.attendance_date, i.calculated_ot_minutes, i.payroll_status, i.payroll_calculation_id, i.proposed_action])]
        );
      }
      await commitAsync(conn);
      return batchId;
    } catch (err) {
      await rollbackAsync(conn);
      this._log("CREATE-BATCH", err);
      throw err;
    } finally {
      conn.release();
    }
  }

  async listItems(batchId) {
    return this._read(
      "LIST-ITEMS",
      `SELECT review_item_id, employee_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              calculated_ot_minutes, payroll_status, payroll_calculation_id, proposed_action, outcome,
              created_request_id, outcome_detail
         FROM attendance_ot_historical_review_item WHERE review_batch_id = ? ORDER BY review_item_id`,
      [batchId]
    );
  }

  /**
   * OPEN THE DATE FOR THE OT SYNC: the employee's deferred marker, WAITING,
   * source HISTORICAL_REVIEW. A marker already WAITING is left exactly as it
   * is (it already opens the date). Returns what was there before, so a date
   * the sync did not raise can be put back.
   */
  async openMarker({ employee_id, attendance_date, minutes, review_item_id }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const [existing] = await queryAsync(
        conn,
        `SELECT deferred_sync_id, status, source, resolution FROM attendance_ot_deferred_sync
          WHERE employee_id = ? AND attendance_date = ? FOR UPDATE`,
        [employee_id, attendance_date]
      );
      let id;
      let previous = null;
      if (existing && existing.status === "WAITING_FOR_CORRECTION") {
        id = Number(existing.deferred_sync_id);
        previous = { kept: true };
      } else if (existing) {
        id = Number(existing.deferred_sync_id);
        previous = { status: existing.status, source: existing.source, resolution: existing.resolution };
        await queryAsync(
          conn,
          `UPDATE attendance_ot_deferred_sync
              SET status = 'WAITING_FOR_CORRECTION', source = ?, reason = 'HISTORICAL_REVIEW',
                  resolution = NULL, resolved_request_id = NULL, resolved_at = NULL,
                  blocking_request_id = NULL, blocking_request_type = NULL, eligible_ot_minutes = ?
            WHERE deferred_sync_id = ?`,
          [REVIEW_MARKER_SOURCE, minutes, id]
        );
      } else {
        const ins = await queryAsync(
          conn,
          `INSERT INTO attendance_ot_deferred_sync
             (employee_id, attendance_date, reason, eligible_ot_minutes, source)
           VALUES (?, ?, 'HISTORICAL_REVIEW', ?, ?)`,
          [employee_id, attendance_date, minutes, REVIEW_MARKER_SOURCE]
        );
        id = Number(ins.insertId);
      }
      if (!previous || !previous.kept) {
        await queryAsync(
          conn,
          `INSERT INTO attendance_ot_deferred_sync_log
             (deferred_sync_id, employee_id, attendance_date, action, detail, trigger_source)
           VALUES (?, ?, ?, 'DEFERRED', ?, ?)`,
          [id, employee_id, attendance_date, `Historical OT review item #${review_item_id}: ${minutes} min authorised for review`, REVIEW_MARKER_SOURCE]
        );
      }
      await commitAsync(conn);
      return { deferred_sync_id: id, previous };
    } catch (err) {
      await rollbackAsync(conn);
      this._log("OPEN-MARKER", err);
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * CLOSE A MARKER THE REVIEW OPENED when the sync did not raise OT on its
   * date, so no later recalculation can raise it unreviewed: back to its old
   * RESOLVED state, or RESOLVED as HISTORICAL_REVIEW_NOT_RAISED.
   */
  async closeMarker({ deferred_sync_id, employee_id, attendance_date, previous, detail }) {
    if (previous && previous.kept) return;
    await this._read(
      "CLOSE-MARKER",
      `UPDATE attendance_ot_deferred_sync
          SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP(3),
              resolution = ?, source = ?
        WHERE deferred_sync_id = ? AND status = 'WAITING_FOR_CORRECTION'`,
      [
        previous ? previous.resolution || "HISTORICAL_REVIEW_NOT_RAISED" : "HISTORICAL_REVIEW_NOT_RAISED",
        previous ? previous.source : REVIEW_MARKER_SOURCE,
        deferred_sync_id,
      ]
    );
    await this._read(
      "CLOSE-MARKER-LOG",
      `INSERT INTO attendance_ot_deferred_sync_log
         (deferred_sync_id, employee_id, attendance_date, action, detail, trigger_source)
       VALUES (?, ?, ?, 'RESOLVED', ?, ?)`,
      [deferred_sync_id, employee_id, attendance_date, String(detail || "not raised").slice(0, 255), REVIEW_MARKER_SOURCE]
    );
  }

  /**
   * NEVER TWICE: record that the review raised OT on this employee and date.
   * The primary key refuses a second; returns false if one exists.
   */
  async recordRaised({ employee_id, attendance_date, review_item_id, attendance_approval_request_id }) {
    try {
      // Not `_read`: a duplicate is the expected refusal, not an error to log.
      await queryAsync(
        this.db,
        `INSERT INTO attendance_ot_historical_review_raised
           (employee_id, attendance_date, review_item_id, attendance_approval_request_id)
         VALUES (?, ?, ?, ?)`,
        [employee_id, attendance_date, review_item_id, attendance_approval_request_id]
      );
      return true;
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") return false;
      this._log("RECORD-RAISED", err);
      throw err;
    }
  }

  async wasRaised(employee_id, attendance_date) {
    const rows = await this._read(
      "WAS-RAISED",
      `SELECT attendance_approval_request_id FROM attendance_ot_historical_review_raised
        WHERE employee_id = ? AND attendance_date = ?`,
      [employee_id, attendance_date]
    );
    return rows.length > 0;
  }

  async setItemOutcome({ review_item_id, outcome, created_request_id = null, detail = null }) {
    await this._read(
      "SET-ITEM-OUTCOME",
      `UPDATE attendance_ot_historical_review_item
          SET outcome = ?, created_request_id = ?, outcome_detail = ?, decided_at = CURRENT_TIMESTAMP(3)
        WHERE review_item_id = ? AND outcome = 'AUTHORISED'`,
      [outcome, created_request_id, detail === null ? null : String(detail).slice(0, 255), review_item_id]
    );
  }

  async finishBatch({ review_batch_id, status, summary }) {
    await this._read(
      "FINISH-BATCH",
      `UPDATE attendance_ot_historical_review_batch
          SET status = ?, applied_at = CURRENT_TIMESTAMP(3), summary = ?
        WHERE review_batch_id = ?`,
      [status, JSON.stringify(summary), review_batch_id]
    );
  }

  async listBatches() {
    return this._read(
      "LIST-BATCHES",
      `SELECT review_batch_id, DATE_FORMAT(from_date, '%Y-%m-%d') AS from_date, DATE_FORMAT(to_date, '%Y-%m-%d') AS to_date,
              status, item_count, authorised_by_employee_id,
              DATE_FORMAT(authorised_at, '%Y-%m-%d %H:%i:%s') AS authorised_at,
              DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s') AS applied_at, summary
         FROM attendance_ot_historical_review_batch ORDER BY review_batch_id DESC LIMIT 50`,
      []
    );
  }
}

module.exports = (db) => new AttendanceOtHistoricalReviewRepository(db);
module.exports.AttendanceOtHistoricalReviewRepository = AttendanceOtHistoricalReviewRepository;
module.exports.REVIEW_MARKER_SOURCE = REVIEW_MARKER_SOURCE;
module.exports.REVIEW_TABLES = REVIEW_TABLES;
