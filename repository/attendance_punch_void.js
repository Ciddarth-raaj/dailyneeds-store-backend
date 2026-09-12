const logger = require("../utils/logger");
const { queryAsync } = require("../utils/batchInsert");

/**
 * The manual void of a raw punch - `attendance_punch_void`.
 *
 * This is the ONLY writer of that table, and it writes ONE kind of row:
 * "this raw punch must not count", with the reason and the actor. It issues
 * no INSERT, UPDATE or DELETE against `biomax_punch` or `biomax_punch_derived`
 * (R8, R9): the raw punch is read here so the void can snapshot it, and is
 * then left exactly as the receiver or the import stored it.
 *
 * There is no un-void. A void is a decision on the record; the raw punch is
 * still there for anyone who needs to see what was excluded and why.
 *
 * Every time leaves the database as a STRING via DATE_FORMAT (R4).
 */
class AttendancePunchVoidRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_PUNCH_VOID",
      code: `REPOSITORY.ATTENDANCE_PUNCH_VOID.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  async _query(code, sql, params) {
    try {
      return await queryAsync(this.db, sql, params);
    } catch (err) {
      this._log(code, err);
      throw err;
    }
  }

  /**
   * The raw punch a void would apply to, with everything the usecase must
   * check: how it was ingested, whom ingest matched it to, and whether it is
   * already voided. Null when no such raw punch exists.
   */
  async getRawPunchForVoid(biomaxPunchId) {
    const rows = await this._query(
      "GET-RAW-PUNCH",
      `SELECT p.biomax_punch_id,
              p.dev_id,
              p.user_id,
              p.ingest_source,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s') AS io_time,
              DATE_FORMAT(p.punch_date, '%Y-%m-%d')       AS punch_date,
              d.employee_id,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d')  AS ingest_attendance_date,
              e.employee_name,
              v.attendance_punch_void_id,
              v.reason                                    AS void_reason,
              v.voided_by_employee_id,
              DATE_FORMAT(v.voided_at, '%Y-%m-%d %H:%i:%s') AS voided_at
         FROM biomax_punch p
         LEFT JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
         LEFT JOIN new_employee e ON e.employee_id = d.employee_id AND e.employee_id > 0
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        WHERE p.biomax_punch_id = ?`,
      [biomaxPunchId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Record the void. The UNIQUE KEY on `biomax_punch_id` is the guard against
   * two voids of one punch; a duplicate-key error is reported as
   * `already_voided: true` so the usecase can answer plainly rather than 500.
   */
  async insertVoid(row) {
    try {
      const result = await queryAsync(
        this.db,
        `INSERT INTO attendance_punch_void
           (biomax_punch_id, punch_source, employee_id, punch_io_time, attendance_date,
            reason, voided_by_employee_id, voided_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.biomax_punch_id,
          row.punch_source,
          row.employee_id,
          row.punch_io_time,
          row.attendance_date === undefined ? null : row.attendance_date,
          row.reason,
          row.voided_by_employee_id === undefined ? null : row.voided_by_employee_id,
          row.voided_by_user_id === undefined ? null : row.voided_by_user_id,
        ]
      );
      return { attendance_punch_void_id: result.insertId, already_voided: false };
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") return { attendance_punch_void_id: null, already_voided: true };
      this._log("INSERT-VOID", err, { biomax_punch_id: row.biomax_punch_id });
      throw err;
    }
  }

  /** One void row, as stored, for the response. */
  async getVoid(attendancePunchVoidId) {
    const rows = await this._query(
      "GET-VOID",
      `SELECT v.attendance_punch_void_id, v.biomax_punch_id, v.punch_source, v.employee_id,
              DATE_FORMAT(v.punch_io_time, '%Y-%m-%d %H:%i:%s') AS punch_io_time,
              DATE_FORMAT(v.attendance_date, '%Y-%m-%d')        AS attendance_date,
              v.reason, v.voided_by_employee_id, v.voided_by_user_id,
              DATE_FORMAT(v.voided_at, '%Y-%m-%d %H:%i:%s')     AS voided_at,
              a.employee_name                                   AS voided_by_name
         FROM attendance_punch_void v
         LEFT JOIN new_employee a ON a.employee_id = v.voided_by_employee_id
        WHERE v.attendance_punch_void_id = ?`,
      [attendancePunchVoidId]
    );
    return rows && rows[0] ? rows[0] : null;
  }
}

module.exports = (db) => new AttendancePunchVoidRepository(db);
module.exports.AttendancePunchVoidRepository = AttendancePunchVoidRepository;
