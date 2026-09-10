/**
 * Biomax receiver - the ONLY write path to the raw punch tables.
 *
 * Owns a small pool of its own (the receiver is a separate pm2 process from
 * the API) built from the same `config.json` section the API uses. Reads
 * exactly what date attribution needs and nothing more (R18):
 *
 *   biomax_device               is this Cloud ID registered? (+ last-seen upkeep)
 *   new_employee                employee_id, store_id, department_id,
 *                               default_work_shift_id - four columns
 *   work_shift_weekly_schedule  work_shift_weekly_schedule_id, is_working_day,
 *                               attendance_day_cutoff - three columns
 *
 * Writes:
 *
 *   biomax_punch          INSERT ... ON DUPLICATE KEY UPDATE retransmit counter (R2)
 *   biomax_punch_derived  one row per NEW punch, same transaction (R16)
 *   biomax_raw_request    diagnostics
 *   biomax_device         first/last_seen_at, last_punch_at
 *
 * `io_time` is converted from the 14-digit string by MySQL's STR_TO_DATE in
 * the INSERT itself; no JS Date is ever bound (R3). `attendance_date` arrives
 * as a 'YYYY-MM-DD' string from attendanceDate.js (UTC integer math) and is
 * bound as-is.
 */

const mysql = require("mysql");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

const SCHEDULE_CACHE_MS = 60 * 1000;

function createPool(dbConfig) {
  return mysql.createPool({
    connectionLimit: 3,
    host: dbConfig.host,
    user: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.database,
    port: dbConfig.port,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // TIME/DATE/DATETIME come back as the strings MySQL holds. The receiver
    // never wants a JS Date for any of them (R3/R4).
    dateStrings: true,
  });
}

/**
 * @param {object} pool a `mysql` pool (or anything with .query/.getConnection)
 * @param {object} [options]
 * @param {function} [options.now] clock, for the schedule cache
 */
function createStore(pool, options = {}) {
  const now = options.now || (() => Date.now());
  const scheduleCache = new Map(); // `${shift}:${dow}` -> {at, row}

  const q = (sql, params) => queryAsync(pool, sql, params);

  /* ------------------------------------------------------------- reads -- */

  async function findDevice(devId) {
    const rows = await q(
      "SELECT biomax_device_id, first_seen_at FROM biomax_device WHERE dev_id = ?",
      [devId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** The four columns date attribution needs. `> 0` belt-and-braces (R5). */
  async function findEmployee(employeeId) {
    if (employeeId === null || employeeId === undefined || employeeId <= 0) return null;
    const rows = await q(
      `SELECT employee_id, store_id, department_id, default_work_shift_id
         FROM new_employee
        WHERE employee_id = ? AND employee_id > 0`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * The previous day's schedule row for a shift - ONLY the three columns
   * attendanceDate.js may read. Cached for a minute per (shift, weekday):
   * a shift edit therefore reaches new punches within a minute, and never
   * reaches old ones (R16).
   */
  async function findScheduleRow(workShiftId, dayOfWeek) {
    const key = `${workShiftId}:${dayOfWeek}`;
    const hit = scheduleCache.get(key);
    if (hit && now() - hit.at < SCHEDULE_CACHE_MS) return hit.row;
    const rows = await q(
      `SELECT work_shift_weekly_schedule_id, is_working_day, attendance_day_cutoff
         FROM work_shift_weekly_schedule
        WHERE work_shift_id = ? AND day_of_week = ?`,
      [workShiftId, dayOfWeek]
    );
    const row = rows && rows[0] ? rows[0] : null;
    scheduleCache.set(key, { at: now(), row });
    return row;
  }

  /* ------------------------------------------------------------ writes -- */

  /**
   * Store a punch and its derived row atomically.
   *
   * @returns {{outcome: 'stored'|'duplicate', biomax_punch_id: number|null}}
   */
  async function insertPunch(punch, derived) {
    const connection = await getConnectionAsync(pool);
    try {
      await beginTransactionAsync(connection);

      const result = await queryAsync(
        connection,
        `INSERT INTO biomax_punch
           (dev_id, user_id, io_time_raw, io_time,
            verify_mode, io_mode, fk_bin_data_lib, log_image_present,
            cmd_id, blk_no, blk_len, content_length, body_len_prefix, raw_json,
            source_ip, source_port)
         VALUES (?, ?, ?, STR_TO_DATE(?, '%Y%m%d%H%i%s'),
                 ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?,
                 ?, ?)
         ON DUPLICATE KEY UPDATE
           retransmit_count = retransmit_count + 1,
           last_retransmit_at = NOW(3)`,
        [
          punch.dev_id,
          punch.user_id,
          punch.io_time_raw,
          punch.io_time_raw,
          punch.verify_mode,
          punch.io_mode,
          punch.fk_bin_data_lib,
          punch.log_image_present ? 1 : 0,
          punch.cmd_id,
          punch.blk_no,
          punch.blk_len,
          punch.content_length,
          punch.body_len_prefix,
          punch.raw_json,
          punch.source_ip,
          punch.source_port,
        ]
      );

      // mysql: affectedRows 1 = inserted, 2 = existing row updated.
      if (result.affectedRows !== 1) {
        await commitAsync(connection);
        return { outcome: "duplicate", biomax_punch_id: null };
      }
      const punchId = result.insertId;

      await queryAsync(
        connection,
        `INSERT INTO biomax_punch_derived
           (biomax_punch_id, attendance_date, derivation_status,
            employee_id, home_outlet_id, department_id,
            work_shift_id, work_shift_weekly_schedule_id, cutoff_applied,
            derived_at, derivation_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NULL)`,
        [
          punchId,
          derived.attendance_date,
          derived.status,
          derived.employee_id,
          derived.home_outlet_id,
          derived.department_id,
          derived.work_shift_id,
          derived.work_shift_weekly_schedule_id,
          derived.cutoff_applied,
        ]
      );

      await commitAsync(connection);
      return { outcome: "stored", biomax_punch_id: Number(punchId) };
    } catch (err) {
      await rollbackAsync(connection).catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  async function insertRawRequest(entry) {
    const frame = entry.raw_frame
      ? Buffer.isBuffer(entry.raw_frame)
        ? entry.raw_frame.subarray(0, 65535)
        : Buffer.from(String(entry.raw_frame)).subarray(0, 65535)
      : null;
    await q(
      `INSERT INTO biomax_raw_request
         (source_ip, dev_id, request_code, outcome, reason, byte_length, raw_frame)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.source_ip || null,
        entry.dev_id || null,
        entry.request_code || null,
        entry.outcome,
        entry.reason ? String(entry.reason).slice(0, 255) : null,
        entry.byte_length || 0,
        frame,
      ]
    );
  }

  /** last_seen_at on every request; first_seen_at once; last_punch_at on punches. */
  async function touchDevice(devId, { punch } = {}) {
    await q(
      `UPDATE biomax_device
          SET first_seen_at = COALESCE(first_seen_at, NOW(3)),
              last_seen_at = NOW(3)
              ${punch ? ", last_punch_at = NOW(3)" : ""}
        WHERE dev_id = ?`,
      [devId]
    );
  }

  async function ping() {
    await q("SELECT 1", []);
    return true;
  }

  async function lastPunchAt() {
    const rows = await q(
      "SELECT DATE_FORMAT(MAX(received_at), '%Y-%m-%d %H:%i:%s') AS last_received FROM biomax_punch",
      []
    );
    return rows && rows[0] ? rows[0].last_received : null;
  }

  function close() {
    return new Promise((resolve) => {
      if (pool && typeof pool.end === "function") pool.end(() => resolve());
      else resolve();
    });
  }

  return {
    findDevice,
    findEmployee,
    findScheduleRow,
    insertPunch,
    insertRawRequest,
    touchDevice,
    ping,
    lastPunchAt,
    close,
  };
}

module.exports = { createPool, createStore, SCHEDULE_CACHE_MS };
