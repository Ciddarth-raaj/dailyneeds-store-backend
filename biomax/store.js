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
 * Historical pull scaffolding (docs/biomax-historical-pull.md):
 *
 *   biomax_device_command       claim the oldest PENDING GET_LOG_DATA for a
 *                               device on its poll - at most once per command
 *   biomax_historical_pull      status transitions the receiver owns:
 *                               REQUESTED -> WAITING_DEVICE -> RECEIVING,
 *                               and -> FAILED on a failing cmd_return_code.
 *                               COMPLETED is set by nothing yet (its
 *                               protocol semantics are unproven).
 *   biomax_command_result_block one row per (dev_id, trans_id, blk_no), raw
 *                               body kept byte for byte; a repeat with the
 *                               same bytes counts, a repeat with different
 *                               bytes is counted as a conflict and the
 *                               stored bytes are left alone.
 *
 * `io_time` is converted from the 14-digit string by MySQL's STR_TO_DATE in
 * the INSERT itself; no JS Date is ever bound (R3). `attendance_date` arrives
 * as a 'YYYY-MM-DD' string from attendanceDate.js (UTC integer math) and is
 * bound as-is.
 */

const mysql = require("mysql");
const crypto = require("crypto");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

const SCHEDULE_CACHE_MS = 60 * 1000;

/** biomax_raw_request.raw_frame is a BLOB: 65535 bytes, headers included. */
const RAW_FRAME_MAX_BYTES = 65535;

/** How a punch row got here (biomax_punch.ingest_source). */
const INGEST_SOURCE = { LIVE: "LIVE", HISTORICAL_PULL: "HISTORICAL_PULL", DIGISME_IMPORT: "DIGISME_IMPORT" };

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * The receiver's pool. `connectionLimit` stays 3 - the fix for the 2026-09
 * OOM was to stop queueing unbounded work on it, not to widen it.
 *
 * options.queueLimit    waiters the pool will hold before failing fast with
 *                       POOL_ENQUEUELIMIT (mysql's own default, 0, is
 *                       unlimited - that queue was the leak)
 * options.acquireTimeoutMs / connectTimeoutMs  how long connecting or the
 *                       pre-use ping of a pooled connection may take
 * options.connectionLimit  3 unless said otherwise (the /healthz pool uses 1)
 */
function createPool(dbConfig, options = {}) {
  return mysql.createPool({
    connectionLimit: Number.isSafeInteger(options.connectionLimit) && options.connectionLimit > 0 ? options.connectionLimit : 3,
    queueLimit: Number.isSafeInteger(options.queueLimit) && options.queueLimit >= 0 ? options.queueLimit : 0,
    ...(options.acquireTimeoutMs ? { acquireTimeout: options.acquireTimeoutMs } : {}),
    ...(options.connectTimeoutMs ? { connectTimeout: options.connectTimeoutMs } : {}),
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
 * @param {number} [options.acquireTimeoutMs] give up waiting for a pooled
 *   connection after this long (error code BIOMAX_POOL_ACQUIRE_TIMEOUT).
 *   mysql's own acquireTimeout does NOT cover time spent in the pool's
 *   queue, only connecting - this does.
 * @param {number} [options.queryTimeoutMs] per-statement timeout (mysql's
 *   `timeout`; the connection is destroyed, which rolls back any open
 *   transaction server-side).
 *
 * Both are off unless given: the API's DigiSME import builds a store on the
 * API pool and keeps its behaviour. The receiver always passes them.
 */
function createStore(pool, options = {}) {
  const now = options.now || (() => Date.now());
  const scheduleCache = new Map(); // `${shift}:${dow}` -> {at, row}
  const assignmentCache = new Map(); // `assignments:${employee}` -> {at, rows}
  const acquireTimeoutMs = positiveOrNull(options.acquireTimeoutMs);
  const queryTimeoutMs = positiveOrNull(options.queryTimeoutMs);
  const timed = acquireTimeoutMs !== null || queryTimeoutMs !== null;
  let closed = false;

  /** A pooled connection, or an error within acquireTimeoutMs. */
  function acquire() {
    if (closed) return Promise.reject(poolClosedError());
    if (acquireTimeoutMs === null) return getConnectionAsync(pool);
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        const err = new Error(`no database connection within ${acquireTimeoutMs} ms (receiver pool saturated)`);
        err.code = "BIOMAX_POOL_ACQUIRE_TIMEOUT";
        reject(err);
      }, acquireTimeoutMs);
      pool.getConnection((err, connection) => {
        clearTimeout(timer);
        if (expired) {
          // Too late for the caller; hand it straight back.
          if (connection) connection.release();
          return;
        }
        if (err) reject(err);
        else resolve(connection);
      });
    });
  }

  /** One statement on a held connection, under queryTimeoutMs. */
  function cq(connection, sql, params) {
    if (queryTimeoutMs === null) return queryAsync(connection, sql, params);
    return queryAsync(connection, { sql, timeout: queryTimeoutMs }, params);
  }
  function commitT(connection) {
    if (queryTimeoutMs === null) return commitAsync(connection);
    return new Promise((resolve, reject) => connection.commit({ timeout: queryTimeoutMs }, (err) => (err ? reject(err) : resolve())));
  }

  async function q(sql, params) {
    if (closed) throw poolClosedError();
    if (!timed) return queryAsync(pool, sql, params);
    const connection = await acquire();
    try {
      return await cq(connection, sql, params);
    } finally {
      connection.release();
    }
  }

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
   * The employee's DATED shift-assignment history (A0), cached for a minute
   * exactly as the schedule rows are.
   *
   * This is what makes a punch's shift the SAME answer the attendance
   * engine, the dashboard and payroll give for that date. Dating used to
   * read `new_employee.default_work_shift_id` instead, and because a
   * punch's derivation status is written once at ingest, any disagreement
   * between the two became permanent - an employee assigned a shift after
   * their punches arrived stayed "No Shift" in the Punch Audit for ever.
   *
   * Two columns and nothing else: the resolver in `utils/shiftResolution.js`
   * needs the effective date, the shift and the id it breaks ties on.
   */
  async function findShiftAssignments(employeeId) {
    if (employeeId === null || employeeId === undefined || employeeId <= 0) return [];
    const key = `assignments:${employeeId}`;
    const hit = assignmentCache.get(key);
    if (hit && now() - hit.at < SCHEDULE_CACHE_MS) return hit.rows;
    const rows = await q(
      `SELECT employee_work_shift_assignment_id, work_shift_id,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from
         FROM employee_work_shift_assignment
        WHERE employee_id = ?`,
      [employeeId]
    );
    const list = rows || [];
    assignmentCache.set(key, { at: now(), rows: list });
    return list;
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
  async function insertPunch(punch, derived, options = {}) {
    if (options.source === INGEST_SOURCE.DIGISME_IMPORT) return insertImportedPunch(punch, derived, options);
    const source = options.source === INGEST_SOURCE.HISTORICAL_PULL ? INGEST_SOURCE.HISTORICAL_PULL : INGEST_SOURCE.LIVE;
    const pullId = source === INGEST_SOURCE.HISTORICAL_PULL ? options.historicalPullId || null : null;
    if (source === INGEST_SOURCE.HISTORICAL_PULL && !pullId) {
      throw new Error("a HISTORICAL_PULL punch must name its biomax_historical_pull_id");
    }
    const connection = await acquire();
    try {
      await beginTransactionAsync(connection);

      // A historical punch never touches an existing row: not the
      // retransmission counter (that means "the device re-sent a live
      // punch"), not the source, nothing. Same unique key, looked up first.
      if (source === INGEST_SOURCE.HISTORICAL_PULL) {
        const existing = await cq(
          connection,
          `SELECT biomax_punch_id FROM biomax_punch
            WHERE dev_id = ? AND user_id = ? AND io_time_raw = ?`,
          [punch.dev_id, punch.user_id, punch.io_time_raw]
        );
        if (existing && existing[0]) {
          await commitT(connection);
          return { outcome: "duplicate", biomax_punch_id: Number(existing[0].biomax_punch_id) };
        }
      }

      const result = await cq(
        connection,
        `INSERT INTO biomax_punch
           (dev_id, user_id, io_time_raw, io_time,
            verify_mode, io_mode, fk_bin_data_lib, log_image_present,
            cmd_id, blk_no, blk_len, content_length, body_len_prefix, raw_json,
            source_ip, source_port, ingest_source, biomax_historical_pull_id)
         VALUES (?, ?, ?, STR_TO_DATE(?, '%Y%m%d%H%i%s'),
                 ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?)
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
          source,
          pullId,
        ]
      );

      // mysql: affectedRows 1 = inserted, 2 = existing row updated.
      if (result.affectedRows !== 1) {
        await commitT(connection);
        return { outcome: "duplicate", biomax_punch_id: null };
      }
      const punchId = result.insertId;

      await cq(
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

      await commitT(connection);
      return { outcome: "stored", biomax_punch_id: Number(punchId) };
    } catch (err) {
      await rollbackAsync(connection).catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * A punch from DigiSME - the Excel import or the API pull, which are the
   * SAME ingest source and the same row shape on purpose (see the
   * `import_dedup_key` note below). No terminal, no BM70W JSON, nothing
   * invented; `raw_json` carries the vendor's own row when the caller has
   * one and stays NULL when it does not. Dedup is the database's: the STORED generated column
   * import_dedup_key (source|code|time, NULL for device rows) is UNIQUE, so
   * a second import of the same punch - concurrent or later - is an
   * ER_DUP_ENTRY, reported here as `duplicate` with the existing row's id.
   * A LIVE punch at the same employee and time has a different key and is
   * never touched; the caller records that as a cross-source collision.
   *
   * @returns {{outcome: 'stored'|'duplicate', biomax_punch_id: number|null}}
   */
  async function insertImportedPunch(punch, derived, options) {
    if (!options.importBatchId) throw new Error("a DIGISME_IMPORT punch must name its import_batch_id");
    const connection = await acquire();
    try {
      await beginTransactionAsync(connection);
      let result;
      try {
        result = await cq(
          connection,
          `INSERT INTO biomax_punch
             (dev_id, user_id, io_time_raw, io_time,
              verify_mode, io_mode, fk_bin_data_lib, log_image_present,
              cmd_id, blk_no, blk_len, content_length, body_len_prefix, raw_json,
              source_ip, source_port, ingest_source, biomax_historical_pull_id, import_batch_id)
           VALUES (NULL, ?, ?, STR_TO_DATE(?, '%Y%m%d%H%i%s'),
                   NULL, NULL, NULL, 0,
                   NULL, NULL, NULL, NULL, NULL, ?,
                   NULL, NULL, ?, NULL, ?)`,
          [
            punch.user_id,
            punch.io_time_raw,
            punch.io_time_raw,
            // The vendor row, when one exists. An Excel import passes
            // nothing and keeps writing NULL, exactly as before: a
            // spreadsheet cell has no payload to preserve. The DigiSME API
            // does, and `raw_json` is where PunchAction, Source,
            // ClockLocation and JobLocation are kept - see
            // services/digisme_attendance.js. `io_mode` stays NULL for both.
            punch.raw_json === undefined ? null : punch.raw_json,
            INGEST_SOURCE.DIGISME_IMPORT,
            options.importBatchId,
          ]
        );
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          await rollbackAsync(connection).catch(() => {});
          const existing = await q(
            `SELECT biomax_punch_id FROM biomax_punch
              WHERE dev_id IS NULL AND ingest_source = ? AND user_id = ? AND io_time_raw = ?`,
            [INGEST_SOURCE.DIGISME_IMPORT, punch.user_id, punch.io_time_raw]
          );
          return { outcome: "duplicate", biomax_punch_id: existing && existing[0] ? Number(existing[0].biomax_punch_id) : null };
        }
        throw err;
      }
      const punchId = result.insertId;
      await cq(
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
      await commitT(connection);
      return { outcome: "stored", biomax_punch_id: Number(punchId) };
    } catch (err) {
      await rollbackAsync(connection).catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * One biomax_raw_request row. raw_frame is a BLOB (65535 bytes): a longer
   * frame is cut to fit - fine for a diagnostic row, never for durability.
   * With `requireComplete` (the receiver's R1 path: a frame ACKed on the
   * strength of this row) a frame that would not fit whole is REFUSED with
   * BIOMAX_FRAME_TOO_LARGE_TO_PRESERVE and nothing is written.
   */
  async function insertRawRequest(entry, options = {}) {
    if (options.requireComplete) {
      const len = entry.raw_frame ? (Buffer.isBuffer(entry.raw_frame) ? entry.raw_frame.length : Buffer.byteLength(String(entry.raw_frame))) : 0;
      if (len > RAW_FRAME_MAX_BYTES) {
        const err = new Error(`frame of ${len} bytes cannot be preserved whole (raw_frame holds ${RAW_FRAME_MAX_BYTES})`);
        err.code = "BIOMAX_FRAME_TOO_LARGE_TO_PRESERVE";
        throw err;
      }
    }
    const frame = entry.raw_frame
      ? Buffer.isBuffer(entry.raw_frame)
        ? entry.raw_frame.subarray(0, RAW_FRAME_MAX_BYTES)
        : Buffer.from(String(entry.raw_frame)).subarray(0, RAW_FRAME_MAX_BYTES)
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

  /**
   * first_seen_at once; last_seen_at; last_punch_at on punches. The receiver
   * no longer calls this on every request: it goes through the housekeeping
   * queue, at most once per device per BIOMAX_DEVICE_TOUCH_INTERVAL_MS for
   * polls and other traffic, and for every punch.
   */
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

  /* ------------------------------------------- historical pull (commands) */

  /**
   * Hand the polling device its next deliverable command, under a lease.
   *
   * Deliverable = PENDING, or SENT whose lease has expired (no result block
   * arrived within leaseSeconds) and which has been handed out fewer than
   * maxAttempts times. The claim is one transaction: SELECT ... FOR UPDATE
   * the oldest such row for THIS dev_id, then an UPDATE guarded on the
   * status and attempt_count just read. Only the poll whose UPDATE changed
   * a row gets the command, so racing polls cannot both receive it, and a
   * re-send carries the SAME trans_id, so its result blocks land on the
   * same rows (deduplicated). A command with maxAttempts hand-outs and
   * still no answer stays SENT and is simply never offered again.
   *
   * @returns {object|null} the command row (with attempt_count after this
   *   hand-out), or null when nothing is deliverable
   */
  async function claimPendingCommand(devId, sourceIp, options = {}) {
    const leaseSeconds = Number.isSafeInteger(options.leaseSeconds) && options.leaseSeconds > 0 ? options.leaseSeconds : 600;
    const maxAttempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 3;
    const connection = await acquire();
    try {
      await beginTransactionAsync(connection);
      const rows = await cq(
        connection,
        `SELECT biomax_device_command_id, biomax_historical_pull_id, trans_id, dev_id, cmd_code, begin_time, end_time, status, attempt_count
           FROM biomax_device_command
          WHERE dev_id = ?
            AND ( status = 'PENDING'
                  OR ( status = 'SENT'
                       AND sent_at < NOW(3) - INTERVAL ? SECOND
                       AND attempt_count < ? ) )
          ORDER BY created_at ASC, biomax_device_command_id ASC
          LIMIT 1
          FOR UPDATE`,
        [devId, leaseSeconds, maxAttempts]
      );
      const command = rows && rows[0] ? rows[0] : null;
      if (!command) {
        await commitT(connection);
        return null;
      }
      const claimed = await cq(
        connection,
        `UPDATE biomax_device_command
            SET status = 'SENT',
                sent_at = NOW(3),
                first_sent_at = COALESCE(first_sent_at, NOW(3)),
                sent_to_ip = ?,
                attempt_count = attempt_count + 1
          WHERE biomax_device_command_id = ? AND dev_id = ?
            AND status IN ('PENDING', 'SENT') AND attempt_count = ?`,
        [sourceIp || null, command.biomax_device_command_id, devId, Number(command.attempt_count) || 0]
      );
      if (!claimed || claimed.affectedRows !== 1) {
        await rollbackAsync(connection);
        return null;
      }
      await cq(
        connection,
        `UPDATE biomax_historical_pull
            SET status = 'WAITING_DEVICE', sent_at = COALESCE(sent_at, NOW(3))
          WHERE biomax_historical_pull_id = ? AND status = 'REQUESTED'`,
        [command.biomax_historical_pull_id]
      );
      await commitT(connection);
      return {
        biomax_device_command_id: Number(command.biomax_device_command_id),
        biomax_historical_pull_id: Number(command.biomax_historical_pull_id),
        trans_id: command.trans_id,
        dev_id: command.dev_id,
        cmd_code: command.cmd_code,
        begin_time: command.begin_time,
        end_time: command.end_time,
        attempt_count: (Number(command.attempt_count) || 0) + 1,
      };
    } catch (err) {
      await rollbackAsync(connection).catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  /** The command a trans_id was issued for - whoever is answering it. */
  async function findCommandByTransId(transId) {
    if (!transId) return null;
    const rows = await q(
      `SELECT biomax_device_command_id, biomax_historical_pull_id, trans_id, dev_id, cmd_code, status
         FROM biomax_device_command
        WHERE trans_id = ?`,
      [transId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Keep one send_cmd_result block, raw. Idempotent on
   * (dev_id, trans_id, blk_no): same bytes again -> duplicate_count;
   * different bytes again -> conflict_count, stored bytes untouched.
   *
   * @returns {{outcome: 'stored'|'duplicate'|'conflict', body_sha256: string}}
   */
  async function insertResultBlock(block) {
    const body = Buffer.isBuffer(block.raw_body) ? block.raw_body : Buffer.alloc(0);
    const hash = sha256(body);
    const transId = block.trans_id === null || block.trans_id === undefined ? "" : String(block.trans_id);
    const blkNo = Number.isInteger(block.blk_no) ? block.blk_no : 0;

    const existing = await q(
      `SELECT body_sha256 FROM biomax_command_result_block
        WHERE dev_id = ? AND trans_id = ? AND blk_no = ?`,
      [block.dev_id, transId, blkNo]
    );
    const prior = existing && existing[0] ? existing[0].body_sha256 : null;

    await q(
      `INSERT INTO biomax_command_result_block
         (biomax_historical_pull_id, dev_id, trans_id, cmd_id, cmd_code, cmd_return_code,
          blk_no, blk_len, content_length, headers_json, body_len, body_sha256, raw_body,
          match_status, source_ip)
       VALUES (?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?,
               ?, ?)
       ON DUPLICATE KEY UPDATE
         duplicate_count = duplicate_count + IF(body_sha256 = VALUES(body_sha256), 1, 0),
         conflict_count  = conflict_count  + IF(body_sha256 = VALUES(body_sha256), 0, 1),
         last_received_at = NOW(3)`,
      [
        block.biomax_historical_pull_id || null,
        block.dev_id,
        transId,
        block.cmd_id || null,
        block.cmd_code || null,
        block.cmd_return_code || null,
        blkNo,
        block.blk_len === undefined ? null : block.blk_len,
        block.content_length === undefined ? null : block.content_length,
        block.headers_json ? String(block.headers_json) : null,
        body.length,
        hash,
        body,
        block.match_status,
        block.source_ip || null,
      ]
    );
    const outcome = prior === null ? "stored" : prior === hash ? "duplicate" : "conflict";
    return { outcome, body_sha256: hash };
  }

  /**
   * A MATCHED block arrived: the command is ANSWERED (its lease ends, it is
   * never re-sent) and the pull is RECEIVING (REQUESTED / WAITING_DEVICE ->
   * RECEIVING once; first_result_at set once).
   */
  async function markPullReceiving(pullId, transId) {
    await q(
      `UPDATE biomax_device_command
          SET status = 'ANSWERED', answered_at = COALESCE(answered_at, NOW(3))
        WHERE biomax_historical_pull_id = ? ${transId ? "AND trans_id = ?" : ""} AND status IN ('PENDING', 'SENT')`,
      transId ? [pullId, transId] : [pullId]
    );
    await q(
      `UPDATE biomax_historical_pull
          SET status = 'RECEIVING', first_result_at = COALESCE(first_result_at, NOW(3))
        WHERE biomax_historical_pull_id = ? AND status IN ('REQUESTED', 'WAITING_DEVICE')`,
      [pullId]
    );
  }

  /**
   * Reserved for an operator action or for return-code semantics once the
   * vocabulary is captured. The receiver does NOT call this today.
   */
  async function markPullFailed(pullId, reason) {
    await q(
      `UPDATE biomax_historical_pull
          SET status = 'FAILED', failed_at = NOW(3), failure_reason = ?
        WHERE biomax_historical_pull_id = ? AND status IN ('REQUESTED', 'WAITING_DEVICE', 'RECEIVING')`,
      [String(reason || "").slice(0, 255), pullId]
    );
    await q(
      `UPDATE biomax_device_command SET status = 'FAILED' WHERE biomax_historical_pull_id = ? AND status <> 'FAILED'`,
      [pullId]
    );
  }

  async function ping() {
    await q("SELECT 1", []);
    return true;
  }

  /**
   * The last punch THIS RECEIVER took off the wire, for /healthz.
   *
   * Scoped to LIVE rows with a dev_id, because the question /healthz answers
   * is "is the Biomax receiver still receiving?" - and only a live
   * realtime_glog from a terminal is evidence of that. A DigiSME row
   * (ingest_source DIGISME_IMPORT, dev_id NULL) is written by the API sync
   * or an Excel import, through a code path the receiver never runs; a
   * HISTORICAL_PULL row is backfill. Counting either would let a receiver
   * that has been deaf for hours report a fresh last_punch_received, which
   * is the exact failure a health endpoint exists to catch.
   */
  async function lastPunchAt() {
    const rows = await q(
      `SELECT DATE_FORMAT(MAX(received_at), '%Y-%m-%d %H:%i:%s') AS last_received
         FROM biomax_punch
        WHERE ingest_source = ? AND dev_id IS NOT NULL`,
      [INGEST_SOURCE.LIVE]
    );
    return rows && rows[0] ? rows[0].last_received : null;
  }

  /**
   * The pool's own counters, for /healthz and the periodic STATS line.
   * mysql 2.x keeps them in underscore fields; read defensively so a fake
   * pool (or a driver upgrade) yields nulls, never a crash.
   */
  function poolStats() {
    const len = (a) => (Array.isArray(a) ? a.length : null);
    const config = pool && pool.config ? pool.config : {};
    return {
      connection_limit: typeof config.connectionLimit === "number" ? config.connectionLimit : null,
      queue_limit: typeof config.queueLimit === "number" ? config.queueLimit : null,
      all: len(pool && pool._allConnections),
      free: len(pool && pool._freeConnections),
      acquiring: len(pool && pool._acquiringConnections),
      queued: len(pool && pool._connectionQueue),
      closed,
    };
  }

  /**
   * End the pool. pool.end() waits for every connection's current statement
   * to finish before its QUIT; with `timeoutMs` a statement still running
   * after that long has its connection destroyed instead (the server rolls
   * back an open transaction; an un-ACKed punch is retransmitted, R1).
   */
  function close({ timeoutMs = 0 } = {}) {
    closed = true;
    return new Promise((resolve) => {
      if (!pool || typeof pool.end !== "function") return resolve();
      const connections = Array.isArray(pool._allConnections) ? pool._allConnections.slice() : [];
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          connections.forEach((c) => {
            try {
              c.destroy();
            } catch (e) {
              /* already gone */
            }
          });
          finish();
        }, timeoutMs);
      }
      pool.end(() => finish());
    });
  }

  return {
    findDevice,
    findEmployee,
    findScheduleRow,
    findShiftAssignments,
    insertPunch,
    insertRawRequest,
    touchDevice,
    claimPendingCommand,
    findCommandByTransId,
    insertResultBlock,
    markPullReceiving,
    markPullFailed,
    ping,
    lastPunchAt,
    poolStats,
    close,
  };
}

function positiveOrNull(v) {
  return Number.isFinite(v) && v > 0 ? v : null;
}

function poolClosedError() {
  const err = new Error("Pool is closed.");
  err.code = "POOL_CLOSED";
  return err;
}

module.exports = { createPool, createStore, SCHEDULE_CACHE_MS, INGEST_SOURCE, RAW_FRAME_MAX_BYTES, sha256 };
