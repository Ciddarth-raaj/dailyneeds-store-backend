const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const {
  assertMonthsNotPayrollLocked,
  writeCalculationsOnConnection,
} = require("./attendance_calculation");

/**
 * DEVICE TIME CORRECTION - the reads and the two transactional writes.
 *
 * The ONLY writer of `attendance_device_time_correction` and
 * `attendance_device_time_correction_punch`. It issues no INSERT, UPDATE or
 * DELETE against `biomax_punch` or `biomax_punch_derived`: the raw punch is
 * read here so a correction can snapshot it, and is then left exactly as the
 * receiver stored it. The corrected time lives in the correction row and is
 * applied at read time (`repository/lib/effective_punch_time.js`).
 *
 * APPLY and REVERT each run in ONE transaction on ONE connection: the
 * correction rows, the payroll-lock gate (`FOR UPDATE`, the same statement
 * every attendance write takes) and the recalculated attendance days commit
 * together or not at all. The punch set is RE-READ inside the transaction and
 * must still match what the administrator previewed.
 *
 * Every time leaves the database as a STRING via DATE_FORMAT (R4).
 */

/** A business refusal with an HTTP status the route passes through. */
function conflictError(message, code) {
  const err = new Error(message);
  err.name = "ConflictError";
  err.code = code;
  err.httpCode = 409;
  return err;
}

/**
 * The candidate punches for a set of criteria: the ONE statement that decides
 * which raw punches a correction touches, used by Preview, by Apply before
 * its transaction and again INSIDE it.
 *
 * Every condition is a filter the administrator entered, and all of them must
 * hold: the DEVICE (by its registry id, hence its exact Cloud ID), the
 * calendar DATE the device stamped, the device-clock WINDOW (both ends
 * inclusive, to the second) and - when given - the OUTLET the device was
 * assigned to at the punch's device time. The window is compared with the
 * RAW device time, `p.io_time`, never an already-corrected one.
 */
function candidateSql(criteria) {
  const where = [
    "bd.biomax_device_id = ?",
    "p.punch_date = ?",
    "p.io_time >= ?",
    "p.io_time <= ?",
  ];
  const params = [criteria.biomax_device_id, criteria.date, criteria.window_from, criteria.window_to];
  if (criteria.outlet_id !== null && criteria.outlet_id !== undefined) {
    where.push("bda.outlet_id = ?");
    params.push(criteria.outlet_id);
  }
  const sql = `SELECT p.biomax_punch_id,
              p.dev_id,
              p.user_id,
              p.ingest_source,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s')     AS io_time,
              DATE_FORMAT(p.received_at, '%Y-%m-%d %H:%i:%s') AS received_at,
              d.employee_id,
              e.employee_name,
              bd.biomax_device_id,
              bd.label                                        AS device_label,
              bda.outlet_id                                   AS punch_outlet_id,
              o.outlet_name                                   AS punch_outlet_name,
              tc.attendance_device_time_correction_id         AS active_correction_id,
              v.attendance_punch_void_id
         FROM biomax_punch p
         JOIN biomax_device bd              ON bd.dev_id = p.dev_id
         LEFT JOIN biomax_punch_derived d   ON d.biomax_punch_id = p.biomax_punch_id
         LEFT JOIN new_employee e           ON e.employee_id = d.employee_id AND e.employee_id > 0
         LEFT JOIN biomax_device_assignment bda
                ON bda.biomax_device_id = bd.biomax_device_id
               AND bda.effective_from <= p.io_time
               AND (bda.effective_to IS NULL OR p.io_time < bda.effective_to)
         LEFT JOIN outlets o                ON o.outlet_id = bda.outlet_id
         LEFT JOIN attendance_device_time_correction_punch tc
                ON tc.active_biomax_punch_id = p.biomax_punch_id
         LEFT JOIN attendance_punch_void v  ON v.biomax_punch_id = p.biomax_punch_id
        WHERE ${where.join(" AND ")}
        ORDER BY p.io_time ASC, p.biomax_punch_id ASC`;
  return { sql, params };
}

class AttendanceDeviceTimeCorrectionRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_DEVICE_TIME_CORRECTION",
      code: `REPOSITORY.ATTENDANCE_DEVICE_TIME_CORRECTION.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  async _query(code, sql, params) {
    try {
      const rows = await queryAsync(this.db, sql, params);
      return rows || [];
    } catch (err) {
      this._log(code, err);
      throw err;
    }
  }

  /* ---------------------------------------------------------------- reads */

  /** Registered devices, each with its location periods, for the form. */
  async listDevices() {
    const [devices, assignments] = await Promise.all([
      this._query(
        "LIST-DEVICES",
        `SELECT biomax_device_id, dev_id, label FROM biomax_device ORDER BY label, biomax_device_id`,
        []
      ),
      this._query(
        "LIST-ASSIGNMENTS",
        `SELECT a.biomax_device_id, a.outlet_id, o.outlet_name,
                DATE_FORMAT(a.effective_from, '%Y-%m-%d %H:%i:%s') AS effective_from,
                DATE_FORMAT(a.effective_to, '%Y-%m-%d %H:%i:%s')   AS effective_to
           FROM biomax_device_assignment a
           LEFT JOIN outlets o ON o.outlet_id = a.outlet_id
          ORDER BY a.biomax_device_id, a.effective_from`,
        []
      ),
    ]);
    return devices.map((d) => ({
      ...d,
      assignments: assignments.filter((a) => Number(a.biomax_device_id) === Number(d.biomax_device_id)),
    }));
  }

  /** One device and its location periods, or null. */
  async getDevice(biomaxDeviceId) {
    const devices = await this._query(
      "GET-DEVICE",
      `SELECT biomax_device_id, dev_id, label FROM biomax_device WHERE biomax_device_id = ?`,
      [biomaxDeviceId]
    );
    if (!devices[0]) return null;
    const assignments = await this._query(
      "GET-DEVICE-ASSIGNMENTS",
      `SELECT a.biomax_device_id, a.outlet_id, o.outlet_name,
              DATE_FORMAT(a.effective_from, '%Y-%m-%d %H:%i:%s') AS effective_from,
              DATE_FORMAT(a.effective_to, '%Y-%m-%d %H:%i:%s')   AS effective_to
         FROM biomax_device_assignment a
         LEFT JOIN outlets o ON o.outlet_id = a.outlet_id
        WHERE a.biomax_device_id = ?
        ORDER BY a.effective_from`,
      [biomaxDeviceId]
    );
    return { ...devices[0], assignments };
  }

  /** The raw punches a set of criteria selects. Read-only. */
  selectCandidatePunches(criteria) {
    const { sql, params } = candidateSql(criteria);
    return this._query("SELECT-CANDIDATES", sql, params);
  }

  /** PENDING attendance / OT requests on these employees' dates - a warning, not a block. */
  async findPendingRequests(employeeIds, dates) {
    const ids = (employeeIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const days = (dates || []).filter(Boolean);
    if (ids.length === 0 || days.length === 0) return [];
    return this._query(
      "FIND-PENDING-REQUESTS",
      `SELECT attendance_approval_request_id, request_type, requested_for_employee_id AS employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date
         FROM attendance_approval_request
        WHERE status = 'PENDING'
          AND requested_for_employee_id IN (?)
          AND attendance_date IN (?)
        ORDER BY requested_for_employee_id, attendance_date`,
      [ids, days]
    );
  }

  async findByBatchRef(batchRef) {
    const rows = await this._query(
      "FIND-BY-BATCH-REF",
      `SELECT attendance_device_time_correction_id, status
         FROM attendance_device_time_correction WHERE batch_ref = ?`,
      [batchRef]
    );
    return rows[0] || null;
  }

  /** The batch list, newest first. */
  listCorrections(limit = 50) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return this._query(
      "LIST",
      `SELECT c.attendance_device_time_correction_id, c.batch_ref,
              DATE_FORMAT(c.correction_date, '%Y-%m-%d')          AS correction_date,
              c.biomax_device_id, c.dev_id, c.device_label, c.outlet_id, o.outlet_name,
              DATE_FORMAT(c.window_from, '%Y-%m-%d %H:%i:%s')     AS window_from,
              DATE_FORMAT(c.window_to, '%Y-%m-%d %H:%i:%s')       AS window_to,
              c.offset_minutes, c.reason_code, c.remarks, c.punch_count, c.employee_count, c.status,
              c.applied_by_employee_id, ab.employee_name          AS applied_by_name,
              DATE_FORMAT(c.applied_at, '%Y-%m-%d %H:%i:%s')      AS applied_at,
              c.reverted_by_employee_id, rb.employee_name         AS reverted_by_name,
              DATE_FORMAT(c.reverted_at, '%Y-%m-%d %H:%i:%s')     AS reverted_at,
              c.revert_reason
         FROM attendance_device_time_correction c
         LEFT JOIN outlets o       ON o.outlet_id = c.outlet_id
         LEFT JOIN new_employee ab ON ab.employee_id = c.applied_by_employee_id
         LEFT JOIN new_employee rb ON rb.employee_id = c.reverted_by_employee_id
        ORDER BY c.attendance_device_time_correction_id DESC
        LIMIT ${n}`,
      []
    );
  }

  /** One batch with every punch it corrected (active or reverted). Null if none. */
  async getCorrection(correctionId) {
    const rows = await this._query(
      "GET",
      `SELECT c.attendance_device_time_correction_id, c.batch_ref,
              DATE_FORMAT(c.correction_date, '%Y-%m-%d')          AS correction_date,
              c.biomax_device_id, c.dev_id, c.device_label, c.outlet_id, o.outlet_name,
              DATE_FORMAT(c.window_from, '%Y-%m-%d %H:%i:%s')     AS window_from,
              DATE_FORMAT(c.window_to, '%Y-%m-%d %H:%i:%s')       AS window_to,
              c.offset_minutes, c.reason_code, c.remarks, c.preview_fingerprint,
              c.punch_count, c.employee_count, c.status,
              c.applied_by_employee_id, c.applied_by_user_id, ab.employee_name AS applied_by_name,
              DATE_FORMAT(c.applied_at, '%Y-%m-%d %H:%i:%s')      AS applied_at,
              c.reverted_by_employee_id, c.reverted_by_user_id, rb.employee_name AS reverted_by_name,
              DATE_FORMAT(c.reverted_at, '%Y-%m-%d %H:%i:%s')     AS reverted_at,
              c.revert_reason
         FROM attendance_device_time_correction c
         LEFT JOIN outlets o       ON o.outlet_id = c.outlet_id
         LEFT JOIN new_employee ab ON ab.employee_id = c.applied_by_employee_id
         LEFT JOIN new_employee rb ON rb.employee_id = c.reverted_by_employee_id
        WHERE c.attendance_device_time_correction_id = ?`,
      [correctionId]
    );
    if (!rows[0]) return null;
    const punches = await this._query(
      "GET-PUNCHES",
      `SELECT cp.attendance_device_time_correction_punch_id, cp.biomax_punch_id, cp.employee_id,
              e.employee_name, p.user_id,
              DATE_FORMAT(cp.original_io_time, '%Y-%m-%d %H:%i:%s')  AS original_io_time,
              DATE_FORMAT(cp.corrected_io_time, '%Y-%m-%d %H:%i:%s') AS corrected_io_time,
              cp.offset_minutes, cp.is_active
         FROM attendance_device_time_correction_punch cp
         JOIN biomax_punch p       ON p.biomax_punch_id = cp.biomax_punch_id
         LEFT JOIN new_employee e  ON e.employee_id = cp.employee_id AND e.employee_id > 0
        WHERE cp.attendance_device_time_correction_id = ?
        ORDER BY cp.original_io_time, cp.biomax_punch_id`,
      [correctionId]
    );
    return { ...rows[0], punches };
  }

  /* --------------------------------------------------------------- writes */

  /**
   * APPLY, in one transaction:
   *
   *   1. re-read the candidate punches ON THIS CONNECTION and require the
   *      same fingerprint the administrator previewed (`fingerprintOf` is the
   *      usecase's, so both sides hash identically) - else PREVIEW_STALE;
   *   2. insert the batch - its UNIQUE `batch_ref` makes a second apply of
   *      one preview ALREADY_APPLIED;
   *   3. insert one row per punch - the UNIQUE active-punch key makes a punch
   *      that already has an active correction ALREADY_CORRECTED;
   *   4. take the payroll lock (`FOR UPDATE`) for every affected employee and
   *      attendance date, stored or not - a locked month refuses the whole
   *      correction;
   *   5. write the recalculated days through the guarded writer.
   *
   * Any failure rolls everything back: no correction row, no day row.
   */
  async applyCorrection({ criteria, expected_fingerprint, fingerprintOf, batch, items, lock_rows, calculation_rows }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const { sql, params } = candidateSql(criteria);
      const current = await queryAsync(connection, sql, params);
      if (fingerprintOf(current || []) !== expected_fingerprint) {
        throw conflictError(
          "The punches for this device and time window have changed since the preview. Preview again before applying.",
          "PREVIEW_STALE"
        );
      }

      let inserted;
      try {
        inserted = await queryAsync(
          connection,
          `INSERT INTO attendance_device_time_correction
             (batch_ref, correction_date, biomax_device_id, dev_id, device_label, outlet_id,
              window_from, window_to, offset_minutes, reason_code, remarks, preview_fingerprint,
              punch_count, employee_count, status, applied_by_employee_id, applied_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPLIED', ?, ?)`,
          [
            batch.batch_ref, batch.correction_date, batch.biomax_device_id, batch.dev_id,
            batch.device_label === undefined ? null : batch.device_label,
            batch.outlet_id === undefined ? null : batch.outlet_id,
            batch.window_from, batch.window_to, batch.offset_minutes, batch.reason_code, batch.remarks,
            expected_fingerprint, batch.punch_count, batch.employee_count,
            batch.applied_by_employee_id === undefined ? null : batch.applied_by_employee_id,
            batch.applied_by_user_id === undefined ? null : batch.applied_by_user_id,
          ]
        );
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          throw conflictError(`Correction batch ${batch.batch_ref} has already been applied.`, "ALREADY_APPLIED");
        }
        throw err;
      }
      const correctionId = inserted.insertId;

      try {
        await queryAsync(
          connection,
          `INSERT INTO attendance_device_time_correction_punch
             (attendance_device_time_correction_id, biomax_punch_id, employee_id,
              original_io_time, corrected_io_time, offset_minutes)
           VALUES ?`,
          [
            items.map((item) => [
              correctionId,
              item.biomax_punch_id,
              item.employee_id === undefined ? null : item.employee_id,
              item.original_io_time,
              item.corrected_io_time,
              item.offset_minutes,
            ]),
          ]
        );
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          throw conflictError(
            "One or more of these punches already has an active device time correction. Revert that correction first.",
            "ALREADY_CORRECTED"
          );
        }
        throw err;
      }

      await assertMonthsNotPayrollLocked(connection, lock_rows);
      const calculation = await writeCalculationsOnConnection(connection, calculation_rows);

      await commitAsync(connection);
      return { attendance_device_time_correction_id: correctionId, ...calculation };
    } catch (err) {
      await rollbackAsync(connection);
      if (!err || err.name !== "ConflictError") this._log("APPLY", err, { batch_ref: batch && batch.batch_ref });
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * REVERT, in one transaction:
   *
   *   1. lock the batch row and require it to still be APPLIED - a second
   *      revert is ALREADY_REVERTED;
   *   2. deactivate its punch rows - they stay, with both times - and require
   *      exactly the rows the usecase calculated for, else CORRECTION_CHANGED;
   *   3. mark the batch REVERTED with who, when and why - never deleted;
   *   4. payroll lock, then the recalculated days, exactly as apply.
   */
  async revertCorrection({ correction_id, expected_active_punch_ids, actor, reason, lock_rows, calculation_rows }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const locked = await queryAsync(
        connection,
        `SELECT attendance_device_time_correction_id, status
           FROM attendance_device_time_correction
          WHERE attendance_device_time_correction_id = ?
          FOR UPDATE`,
        [correction_id]
      );
      if (!locked || !locked[0]) {
        const err = new Error(`No device time correction exists for id ${correction_id}`);
        err.name = "NotFoundError";
        throw err;
      }
      if (String(locked[0].status) !== "APPLIED") {
        throw conflictError(`Device time correction #${correction_id} has already been reverted.`, "ALREADY_REVERTED");
      }

      const active = await queryAsync(
        connection,
        `SELECT biomax_punch_id FROM attendance_device_time_correction_punch
          WHERE attendance_device_time_correction_id = ? AND is_active = 1
          FOR UPDATE`,
        [correction_id]
      );
      const activeIds = (active || []).map((r) => String(r.biomax_punch_id)).sort();
      const expectedIds = (expected_active_punch_ids || []).map(String).sort();
      if (activeIds.join(",") !== expectedIds.join(",")) {
        throw conflictError(
          `Device time correction #${correction_id} changed while the revert was being prepared. Try again.`,
          "CORRECTION_CHANGED"
        );
      }

      await queryAsync(
        connection,
        `UPDATE attendance_device_time_correction_punch
            SET is_active = 0
          WHERE attendance_device_time_correction_id = ? AND is_active = 1`,
        [correction_id]
      );
      await queryAsync(
        connection,
        `UPDATE attendance_device_time_correction
            SET status = 'REVERTED',
                reverted_by_employee_id = ?,
                reverted_by_user_id = ?,
                reverted_at = CURRENT_TIMESTAMP(3),
                revert_reason = ?
          WHERE attendance_device_time_correction_id = ? AND status = 'APPLIED'`,
        [
          actor && actor.employee_id !== undefined ? actor.employee_id : null,
          actor && actor.user_id !== undefined ? actor.user_id : null,
          reason,
          correction_id,
        ]
      );

      await assertMonthsNotPayrollLocked(connection, lock_rows);
      const calculation = await writeCalculationsOnConnection(connection, calculation_rows);

      await commitAsync(connection);
      return { attendance_device_time_correction_id: Number(correction_id), ...calculation };
    } catch (err) {
      await rollbackAsync(connection);
      if (!err || (err.name !== "ConflictError" && err.name !== "NotFoundError")) {
        this._log("REVERT", err, { correction_id });
      }
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = (db) => new AttendanceDeviceTimeCorrectionRepository(db);
module.exports.AttendanceDeviceTimeCorrectionRepository = AttendanceDeviceTimeCorrectionRepository;
module.exports.candidateSql = candidateSql;
