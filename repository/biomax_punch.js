const logger = require("../utils/logger");
const { queryAsync } = require("../utils/batchInsert");

/**
 * READ-ONLY access to the Biomax punch tables for the API.
 *
 * The receiver (biomax/store.js) is the only writer of `biomax_punch` and
 * `biomax_punch_derived`; nothing in this file issues an INSERT, UPDATE or
 * DELETE against either (R8, R9).
 *
 * Every time leaves the database as a STRING via DATE_FORMAT (R4). The
 * API's pool has no `dateStrings` option, so a bare DATETIME would come back
 * as a JS Date built in the process zone and shift every punch by the
 * server's offset. Nothing here selects a bare date/time column.
 *
 * Two views, two questions (R14):
 *
 *   Attendance List   rows of biomax_punch_derived WITH an attendance_date,
 *                     grouped by the usecase into employee x date. Filtered
 *                     by the employee's HOME outlet (snapshotted at ingest),
 *                     never by device or punch location.
 *   Punch Audit       one row per physical punch, any status, filtered by
 *                     device / punch location / source IP / review status.
 *
 * Punch location is resolved BY TIME (R17): the assignment period whose
 * [effective_from, effective_to) contains the punch's io_time. An IMPORTED
 * punch (DigiSME Excel, dev_id NULL) has no terminal and therefore no
 * location; it is a normal, non-quarantined punch with a blank location.
 */

const DEVICE_STATUS_SQL = `CASE
    WHEN p.dev_id IS NULL THEN 'IMPORTED'
    WHEN bd.biomax_device_id IS NULL THEN 'UNREGISTERED_DEVICE'
    WHEN bda.biomax_device_assignment_id IS NULL THEN 'INACTIVE_DEVICE'
    ELSE 'REGISTERED' END`;

/** The SELECT list both views share. */
const PUNCH_COLUMNS = `
  p.biomax_punch_id,
  p.dev_id,
  p.user_id,
  p.io_time_raw,
  DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s')      AS io_time,
  DATE_FORMAT(p.io_time, '%H:%i:%s')               AS clock_time,
  DATE_FORMAT(p.punch_date, '%Y-%m-%d')            AS calendar_date,
  p.source_ip,
  p.ingest_source,
  p.import_batch_id,
  p.retransmit_count,
  DATE_FORMAT(p.received_at, '%Y-%m-%d %H:%i:%s')  AS received_at,
  DATE_FORMAT(d.attendance_date, '%Y-%m-%d')       AS attendance_date,
  d.derivation_status,
  d.employee_id,
  d.home_outlet_id,
  d.department_id,
  d.work_shift_id,
  d.cutoff_applied,
  e.employee_name,
  e.status                                         AS employee_status,
  dep.department_name,
  o_home.outlet_name                               AS home_outlet,
  o_home.outlet_code                               AS home_outlet_code,
  bd.biomax_device_id,
  bd.label                                         AS device_label,
  bda.outlet_id                                    AS punch_outlet_id,
  o_dev.outlet_name                                AS punch_outlet,
  o_dev.outlet_code                                AS punch_outlet_code,
  ${DEVICE_STATUS_SQL}                             AS device_status,
  v.attendance_punch_void_id,
  v.reason                                         AS void_reason,
  v.voided_by_employee_id,
  ve.employee_name                                 AS voided_by_name,
  DATE_FORMAT(v.voided_at, '%Y-%m-%d %H:%i:%s')    AS voided_at`;

/** The FROM/JOIN block both views share. */
const PUNCH_JOINS = `
  FROM biomax_punch p
  LEFT JOIN biomax_punch_derived d  ON d.biomax_punch_id = p.biomax_punch_id
  LEFT JOIN new_employee e          ON e.employee_id = d.employee_id AND e.employee_id > 0
  LEFT JOIN department dep          ON dep.department_id = d.department_id
  LEFT JOIN outlets o_home          ON o_home.outlet_id = d.home_outlet_id
  LEFT JOIN biomax_device bd        ON bd.dev_id = p.dev_id
  LEFT JOIN biomax_device_assignment bda
         ON bda.biomax_device_id = bd.biomax_device_id
        AND bda.effective_from <= p.io_time
        AND (bda.effective_to IS NULL OR p.io_time < bda.effective_to)
  LEFT JOIN outlets o_dev           ON o_dev.outlet_id = bda.outlet_id
  LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
  LEFT JOIN new_employee ve         ON ve.employee_id = v.voided_by_employee_id`;

class BiomaxPunchRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.BIOMAX_PUNCH",
      code: `REPOSITORY.BIOMAX_PUNCH.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  async _read(code, sql, params) {
    try {
      const rows = await queryAsync(this.db, sql, params);
      return rows || [];
    } catch (err) {
      this._log(code, err);
      throw err;
    }
  }

  /**
   * Attendance List source rows: every DATED punch in the range, ordered so
   * the usecase can group them by (employee, attendance_date) in one pass.
   *
   * There is deliberately no dev_id / punch-outlet predicate here (R14):
   * the row is the employee's whole day, whichever terminals saw them.
   *
   * @param {object} f  {from, to, home_outlet_id?, department_id?, search?}
   */
  listDated(f) {
    const where = ["d.attendance_date BETWEEN ? AND ?"];
    const params = [f.from, f.to];
    if (f.home_outlet_id !== undefined && f.home_outlet_id !== null) {
      where.push("d.home_outlet_id = ?");
      params.push(f.home_outlet_id);
    }
    if (f.department_id !== undefined && f.department_id !== null) {
      where.push("d.department_id = ?");
      params.push(f.department_id);
    }
    if (f.search) {
      where.push("(p.user_id = ? OR e.employee_name LIKE ?)");
      params.push(f.search, `%${f.search}%`);
    }
    return this._read(
      "LIST-DATED",
      `SELECT ${PUNCH_COLUMNS} ${PUNCH_JOINS}
        WHERE ${where.join(" AND ")}
        ORDER BY d.attendance_date, d.employee_id, p.io_time, p.biomax_punch_id`,
      params
    );
  }

  /**
   * Punch Audit rows: one per physical punch, any status, by CALENDAR date.
   *
   * @param {object} f  {from, to, dev_id?, punch_outlet_id?, device_status?,
   *                     review?: 'needs_review'|'ok', search?, source_ip?,
   *                     employee_id?, attendance_date?, limit, offset}
   */
  listPunches(f) {
    const where = ["p.punch_date BETWEEN ? AND ?"];
    const params = [f.from, f.to];
    if (f.dev_id) {
      where.push("p.dev_id = ?");
      params.push(f.dev_id);
    }
    if (f.punch_outlet_id !== undefined && f.punch_outlet_id !== null) {
      where.push("bda.outlet_id = ?");
      params.push(f.punch_outlet_id);
    }
    if (f.device_status) {
      where.push(`(${DEVICE_STATUS_SQL}) = ?`);
      params.push(f.device_status);
    }
    // An imported punch (no terminal) has no location to be missing; only
    // its derivation can put it in the review queue.
    if (f.review === "needs_review") {
      where.push("(d.derivation_status IS NULL OR d.derivation_status <> 'OK' OR (p.dev_id IS NOT NULL AND bda.biomax_device_assignment_id IS NULL))");
    } else if (f.review === "ok") {
      where.push("d.derivation_status = 'OK' AND (p.dev_id IS NULL OR bda.biomax_device_assignment_id IS NOT NULL)");
    }
    if (f.search) {
      where.push("(p.user_id = ? OR e.employee_name LIKE ?)");
      params.push(f.search, `%${f.search}%`);
    }
    if (f.source_ip) {
      where.push("p.source_ip = ?");
      params.push(f.source_ip);
    }
    if (f.employee_id !== undefined && f.employee_id !== null) {
      where.push("d.employee_id = ?");
      params.push(f.employee_id);
    }
    if (f.attendance_date) {
      where.push("d.attendance_date = ?");
      params.push(f.attendance_date);
    }
    const limit = Number.isSafeInteger(f.limit) ? f.limit : 500;
    const offset = Number.isSafeInteger(f.offset) ? f.offset : 0;
    return this._read(
      "LIST-PUNCHES",
      `SELECT ${PUNCH_COLUMNS} ${PUNCH_JOINS}
        WHERE ${where.join(" AND ")}
        ORDER BY p.io_time, p.biomax_punch_id
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
  }

  /**
   * The chronological raw stream of some employees over a CALENDAR range, as
   * light as it can be: id, employee, instant, source, void. This is what the
   * Punch Audit needs to say whether a listed punch was IGNORED as a
   * duplicate - the rule compares against the last KEPT punch, so the whole
   * neighbourhood is needed, not only the rows on the page. The caller widens
   * the range by a day at the start for the same reason the calculation does.
   *
   * @param {object} f  {employee_ids: number[], from, to}
   */
  listPunchStreamForEmployees(f) {
    const ids = (f.employee_ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (ids.length === 0) return Promise.resolve([]);
    return this._read(
      "LIST-PUNCH-STREAM",
      `SELECT p.biomax_punch_id,
              d.employee_id,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s') AS io_time,
              p.ingest_source,
              v.attendance_punch_void_id
         FROM biomax_punch_derived d
         JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        WHERE d.employee_id IN (?)
          AND p.punch_date BETWEEN ? AND ?
        ORDER BY d.employee_id, p.io_time, p.biomax_punch_id`,
      [ids, f.from, f.to]
    );
  }

  /**
   * Counts for the banners: how many punches in the CALENDAR range could not
   * be dated and why, how many are quarantined by device status, and which
   * unregistered Cloud IDs were seen.
   */
  async summary(f) {
    const rows = await this._read(
      "SUMMARY",
      `SELECT
          COALESCE(d.derivation_status, 'NO_DERIVED_ROW') AS derivation_status,
          ${DEVICE_STATUS_SQL} AS device_status,
          COUNT(*) AS punches,
          COUNT(DISTINCT p.user_id) AS subjects
        FROM biomax_punch p
        LEFT JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
        LEFT JOIN biomax_device bd ON bd.dev_id = p.dev_id
        LEFT JOIN biomax_device_assignment bda
               ON bda.biomax_device_id = bd.biomax_device_id
              AND bda.effective_from <= p.io_time
              AND (bda.effective_to IS NULL OR p.io_time < bda.effective_to)
        WHERE p.punch_date BETWEEN ? AND ?
        GROUP BY derivation_status, device_status`,
      [f.from, f.to]
    );
    const unregistered = await this._read(
      "SUMMARY-UNREGISTERED",
      `SELECT p.dev_id, COUNT(*) AS punches,
              DATE_FORMAT(MIN(p.io_time), '%Y-%m-%d %H:%i:%s') AS first_punch,
              DATE_FORMAT(MAX(p.io_time), '%Y-%m-%d %H:%i:%s') AS last_punch
         FROM biomax_punch p
         LEFT JOIN biomax_device bd ON bd.dev_id = p.dev_id
        WHERE p.punch_date BETWEEN ? AND ? AND p.dev_id IS NOT NULL AND bd.biomax_device_id IS NULL
        GROUP BY p.dev_id ORDER BY last_punch DESC`,
      [f.from, f.to]
    );
    return { groups: rows, unregistered };
  }

  /** Recent raw-request diagnostics, for the devices screen. */
  recentRawRequests(limit = 100) {
    const n = Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 ? limit : 100;
    return this._read(
      "RAW-REQUESTS",
      `SELECT biomax_raw_request_id, DATE_FORMAT(received_at, '%Y-%m-%d %H:%i:%s') AS received_at,
              source_ip, dev_id, request_code, outcome, reason, byte_length
         FROM biomax_raw_request ORDER BY received_at DESC LIMIT ${n}`,
      []
    );
  }
}

module.exports = (db) => new BiomaxPunchRepository(db);
module.exports.BiomaxPunchRepository = BiomaxPunchRepository;
module.exports.DEVICE_STATUS_SQL = DEVICE_STATUS_SQL;
