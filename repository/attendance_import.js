const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * DigiSME attendance import: the staging tables and the two dedup lookups.
 *
 *   biomax_attendance_import_batch  one row per uploaded file - the audit
 *   biomax_attendance_import_item   one row per candidate punch / bad row
 *
 * Nothing here writes biomax_punch: the commit goes through
 * biomax/store.js (insertPunch with source DIGISME_IMPORT), the same code
 * path and the same tables as a live punch. Import history is never
 * deleted from here; there is no delete method on purpose.
 *
 * All DATETIMEs go out as strings via DATE_FORMAT.
 */
const BATCH_COLUMNS = `
  b.import_batch_id, b.source_type, b.original_filename, b.file_sha256, b.file_size_bytes, b.sheet_name, b.time_columns,
  b.status, b.uploaded_by, b.committed_by,
  DATE_FORMAT(b.created_at,   '%Y-%m-%d %H:%i:%s') AS created_at,
  DATE_FORMAT(b.previewed_at, '%Y-%m-%d %H:%i:%s') AS previewed_at,
  DATE_FORMAT(b.committed_at, '%Y-%m-%d %H:%i:%s') AS committed_at,
  b.excel_row_count, b.employee_code_count, b.candidate_count, b.valid_count, b.bad_count, b.unmatched_count,
  b.reimport_duplicate_count, b.cross_source_collision_count, b.imported_count, b.skipped_count, b.failed_count,
  DATE_FORMAT(b.date_from, '%Y-%m-%d') AS date_from,
  DATE_FORMAT(b.date_to,   '%Y-%m-%d') AS date_to,
  b.error_message,
  ue.employee_name AS uploaded_by_name,
  ce.employee_name AS committed_by_name`;

const ITEM_COLUMNS = `
  i.import_item_id, i.import_batch_id, i.excel_row, i.column_name, i.raw_employee_code, i.raw_clock_date, i.raw_clock_time,
  i.user_id, i.io_time_raw, i.employee_id, i.classification, i.derivation_status,
  DATE_FORMAT(i.attendance_date, '%Y-%m-%d') AS attendance_date,
  i.collided_punch_id, i.message, i.outcome, i.biomax_punch_id,
  DATE_FORMAT(i.committed_at, '%Y-%m-%d %H:%i:%s') AS committed_at`;

const ITEM_INSERT_CHUNK = 500;

class AttendanceImportRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_IMPORT",
      code: `REPOSITORY.ATTENDANCE_IMPORT.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  async _q(code, sql, params, connection) {
    try {
      return await queryAsync(connection || this.db, sql, params);
    } catch (err) {
      this._log(code, err);
      throw err;
    }
  }

  async transaction(code, work) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);
      const result = await work(connection);
      await commitAsync(connection);
      return result;
    } catch (err) {
      await rollbackAsync(connection).catch(() => {});
      this._log(code, err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /* ------------------------------------------------------- dedup lookups */

  /**
   * DigiSME punches already in biomax_punch for these employee codes within
   * [from, to] (14-digit bounds). Returns a Set of "user_id|io_time_raw".
   */
  async existingImportKeys(userIds, fromRaw, toRaw) {
    if (!userIds.length) return new Set();
    const out = new Set();
    for (let i = 0; i < userIds.length; i += 500) {
      const slice = userIds.slice(i, i + 500);
      const rows = await this._q(
        "EXISTING-IMPORT",
        `SELECT user_id, io_time_raw FROM biomax_punch
          WHERE dev_id IS NULL AND ingest_source = 'DIGISME_IMPORT'
            AND user_id IN (?) AND io_time_raw BETWEEN ? AND ?`,
        [slice, fromRaw, toRaw]
      );
      for (const r of rows) out.add(`${r.user_id}|${r.io_time_raw}`);
    }
    return out;
  }

  /**
   * Non-import punches (LIVE / HISTORICAL_PULL) whose RESOLVED employee and
   * exact io_time match a candidate. Keyed on employee identity, not device
   * or raw code. Returns a Map of "employee_id|io_time_raw" -> biomax_punch_id.
   */
  async existingCrossSource(employeeIds, fromRaw, toRaw) {
    const out = new Map();
    if (!employeeIds.length) return out;
    for (let i = 0; i < employeeIds.length; i += 500) {
      const slice = employeeIds.slice(i, i + 500);
      const rows = await this._q(
        "EXISTING-CROSS",
        `SELECT p.biomax_punch_id, p.io_time_raw, d.employee_id
           FROM biomax_punch p
           JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
          WHERE p.ingest_source <> 'DIGISME_IMPORT'
            AND d.employee_id IN (?) AND p.io_time_raw BETWEEN ? AND ?`,
        [slice, fromRaw, toRaw]
      );
      for (const r of rows) {
        const key = `${r.employee_id}|${r.io_time_raw}`;
        if (!out.has(key)) out.set(key, Number(r.biomax_punch_id));
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- writes */

  async insertBatch(connection, b) {
    const r = await this._q(
      "INSERT-BATCH",
      `INSERT INTO biomax_attendance_import_batch
         (source_type, original_filename, file_sha256, file_size_bytes, sheet_name, time_columns, status, uploaded_by,
          previewed_at, excel_row_count, employee_code_count, candidate_count, valid_count, bad_count, unmatched_count,
          reimport_duplicate_count, cross_source_collision_count, date_from, date_to)
       VALUES ('DIGISME_ATD_DAILY', ?, ?, ?, ?, ?, 'PREVIEWED', ?, NOW(3), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.original_filename, b.file_sha256, b.file_size_bytes, b.sheet_name, b.time_columns, b.uploaded_by,
        b.excel_row_count, b.employee_code_count, b.candidate_count, b.valid_count, b.bad_count, b.unmatched_count,
        b.reimport_duplicate_count, b.cross_source_collision_count, b.date_from, b.date_to,
      ],
      connection
    );
    return Number(r.insertId);
  }

  async insertItems(connection, batchId, items) {
    for (let i = 0; i < items.length; i += ITEM_INSERT_CHUNK) {
      const chunk = items.slice(i, i + ITEM_INSERT_CHUNK);
      const values = chunk.map((it) => [
        batchId, it.excel_row, it.column_name, it.raw_employee_code, it.raw_clock_date, it.raw_clock_time,
        it.user_id, it.io_time_raw, it.employee_id, it.classification, it.derivation_status, it.attendance_date,
        it.collided_punch_id, it.message,
      ]);
      await this._q(
        "INSERT-ITEMS",
        `INSERT INTO biomax_attendance_import_item
           (import_batch_id, excel_row, column_name, raw_employee_code, raw_clock_date, raw_clock_time,
            user_id, io_time_raw, employee_id, classification, derivation_status, attendance_date,
            collided_punch_id, message)
         VALUES ?`,
        [values],
        connection
      );
    }
  }

  /** PREVIEWED -> COMMITTING, exactly once. Returns true when this caller won. */
  async claimForCommit(batchId, committedBy) {
    const r = await this._q(
      "CLAIM",
      `UPDATE biomax_attendance_import_batch
          SET status = 'COMMITTING', committed_by = ?
        WHERE import_batch_id = ? AND status = 'PREVIEWED'`,
      [committedBy === undefined ? null : committedBy, batchId]
    );
    return r.affectedRows === 1;
  }

  /**
   * Outcome per item. collided_punch_id is only ever FILLED IN, never
   * overwritten: what preview recorded stays (COALESCE keeps the existing).
   */
  updateItemOutcome(itemId, { outcome, biomax_punch_id, message, collided_punch_id }) {
    return this._q(
      "ITEM-OUTCOME",
      `UPDATE biomax_attendance_import_item
          SET outcome = ?, biomax_punch_id = ?, message = COALESCE(?, message),
              collided_punch_id = COALESCE(collided_punch_id, ?), committed_at = NOW(3)
        WHERE import_item_id = ?`,
      [outcome, biomax_punch_id === undefined ? null : biomax_punch_id, message === undefined ? null : message, collided_punch_id === undefined ? null : collided_punch_id, itemId]
    );
  }

  finishBatch(batchId, { status, imported_count, skipped_count, failed_count, error_message }) {
    return this._q(
      "FINISH",
      `UPDATE biomax_attendance_import_batch
          SET status = ?, committed_at = NOW(3), imported_count = ?, skipped_count = ?, failed_count = ?, error_message = ?
        WHERE import_batch_id = ?`,
      [status, imported_count, skipped_count, failed_count, error_message || null, batchId]
    );
  }

  /* --------------------------------------------------------------- reads */

  list({ limit } = {}) {
    return this._q(
      "LIST",
      `SELECT ${BATCH_COLUMNS}
         FROM biomax_attendance_import_batch b
         LEFT JOIN new_employee ue ON ue.employee_id = b.uploaded_by AND ue.employee_id > 0
         LEFT JOIN new_employee ce ON ce.employee_id = b.committed_by AND ce.employee_id > 0
        ORDER BY b.import_batch_id DESC
        LIMIT ?`,
      [Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
  }

  async getById(batchId) {
    const rows = await this._q(
      "GET",
      `SELECT ${BATCH_COLUMNS}
         FROM biomax_attendance_import_batch b
         LEFT JOIN new_employee ue ON ue.employee_id = b.uploaded_by AND ue.employee_id > 0
         LEFT JOIN new_employee ce ON ce.employee_id = b.committed_by AND ce.employee_id > 0
        WHERE b.import_batch_id = ?`,
      [batchId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** Counts by classification and by outcome, for the detail view. */
  async itemCounts(batchId) {
    const rows = await this._q(
      "ITEM-COUNTS",
      `SELECT classification, outcome, COUNT(*) AS n
         FROM biomax_attendance_import_item WHERE import_batch_id = ?
        GROUP BY classification, outcome`,
      [batchId]
    );
    return rows;
  }

  /**
   * Distinct employee codes STILL unmatched, with how many punches each
   * carries. An item re-matched later (see rematchImportItems) drops out:
   * its outcome is no longer IMPORTED_UNMATCHED.
   */
  unmatchedCodes(batchId, limit = 500) {
    return this._q(
      "UNMATCHED-CODES",
      `SELECT user_id, COUNT(*) AS punches, MIN(excel_row) AS first_excel_row
         FROM biomax_attendance_import_item
        WHERE import_batch_id = ? AND classification = 'UNMATCHED_EMPLOYEE'
          AND (outcome IS NULL OR outcome = 'IMPORTED_UNMATCHED')
        GROUP BY user_id ORDER BY punches DESC, user_id LIMIT ${Math.min(Math.max(Number(limit) || 500, 1), 5000)}`,
      [batchId]
    );
  }

  /* ------------------------------------------------------------ re-match */

  /**
   * Every stored punch whose code matched nobody at ingest - from ANY source
   * (device, historical pull, DigiSME import): the gap is the same whoever
   * delivered the punch. Oldest first, bounded.
   */
  unmatchedPunches(limit = 50000) {
    return this._q(
      "UNMATCHED-PUNCHES",
      `SELECT p.biomax_punch_id, p.user_id, p.io_time_raw, p.ingest_source, p.import_batch_id
         FROM biomax_punch_derived d
         JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
        WHERE d.derivation_status = 'UNMATCHED'
        ORDER BY p.biomax_punch_id
        LIMIT ${Math.min(Math.max(Number(limit) || 50000, 1), 200000)}`,
      []
    );
  }

  /**
   * Attach the identity (and the attendance date that follows from it) to a
   * punch that was UNMATCHED at ingest. The raw punch row is never touched;
   * only the derived row moves, and only while it is still UNMATCHED, so a
   * concurrent re-match cannot overwrite a result with a stale one.
   * @returns {boolean} whether the row was still unmatched and got updated
   */
  async rematchPunch(punchId, derived) {
    const r = await this._q(
      "REMATCH-PUNCH",
      `UPDATE biomax_punch_derived
          SET employee_id = ?, home_outlet_id = ?, department_id = ?,
              work_shift_id = ?, work_shift_weekly_schedule_id = ?, cutoff_applied = ?,
              attendance_date = ?, derivation_status = ?, derived_at = NOW(3)
        WHERE biomax_punch_id = ? AND derivation_status = 'UNMATCHED'`,
      [
        derived.employee_id,
        derived.home_outlet_id,
        derived.department_id,
        derived.work_shift_id,
        derived.work_shift_weekly_schedule_id,
        derived.cutoff_applied,
        derived.attendance_date,
        derived.status,
        punchId,
      ]
    );
    return Boolean(r && r.affectedRows);
  }

  /** The import audit follows: an IMPORTED_UNMATCHED item becomes IMPORTED, with a note saying when. */
  rematchImportItems(punchId, { employee_id, derivation_status, attendance_date, message }) {
    return this._q(
      "REMATCH-ITEMS",
      `UPDATE biomax_attendance_import_item
          SET employee_id = ?, derivation_status = ?, attendance_date = ?, outcome = 'IMPORTED', message = ?
        WHERE biomax_punch_id = ? AND outcome = 'IMPORTED_UNMATCHED'`,
      [employee_id, derivation_status, attendance_date, message, punchId]
    );
  }

  /** Paginated items, optionally by classification / outcome. */
  async items(batchId, { classification, outcome, limit, offset } = {}) {
    const where = ["i.import_batch_id = ?"];
    const params = [batchId];
    if (classification) {
      where.push("i.classification = ?");
      params.push(classification);
    }
    if (outcome) {
      where.push("i.outcome = ?");
      params.push(outcome);
    }
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await this._q(
      "ITEMS",
      `SELECT ${ITEM_COLUMNS}
         FROM biomax_attendance_import_item i
        WHERE ${where.join(" AND ")}
        ORDER BY i.excel_row, i.import_item_id
        LIMIT ${lim} OFFSET ${off}`,
      params
    );
    const total = await this._q("ITEMS-COUNT", `SELECT COUNT(*) AS n FROM biomax_attendance_import_item i WHERE ${where.join(" AND ")}`, params);
    return { rows, total: total && total[0] ? Number(total[0].n) : rows.length, limit: lim, offset: off };
  }

  /** Every item commit must act on, in Excel order, with what preview decided. */
  itemsForCommit(batchId) {
    return this._q(
      "ITEMS-COMMIT",
      `SELECT import_item_id, excel_row, column_name, user_id, io_time_raw, employee_id, classification, collided_punch_id
         FROM biomax_attendance_import_item
        WHERE import_batch_id = ? AND outcome IS NULL
        ORDER BY excel_row, import_item_id`,
      [batchId]
    );
  }
}

module.exports = (db) => new AttendanceImportRepository(db);
module.exports.AttendanceImportRepository = AttendanceImportRepository;
