const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * Historical pull requests, as the API sees them.
 *
 * The API CREATES a pull (and its one GET_LOG_DATA command) and READS pulls
 * and block summaries. It never hands a command to a device and never
 * touches a result block's bytes - both are the receiver's (biomax/store.js).
 * Raw bodies are deliberately not selectable from here: nothing in a normal
 * UI endpoint needs them.
 *
 * All DATETIMEs go out as strings; all come in as 'YYYY-MM-DD HH:MM:SS'
 * strings the usecase has validated.
 */
const PULL_COLUMNS = `
  p.biomax_historical_pull_id, p.biomax_device_id, p.dev_id, d.label AS device_label,
  DATE_FORMAT(p.requested_from, '%Y-%m-%d %H:%i:%s') AS requested_from,
  DATE_FORMAT(p.requested_to,   '%Y-%m-%d %H:%i:%s') AS requested_to,
  p.status, p.trans_id, p.requested_by,
  DATE_FORMAT(p.requested_at,    '%Y-%m-%d %H:%i:%s') AS requested_at,
  DATE_FORMAT(p.sent_at,         '%Y-%m-%d %H:%i:%s') AS sent_at,
  DATE_FORMAT(p.first_result_at, '%Y-%m-%d %H:%i:%s') AS first_result_at,
  DATE_FORMAT(p.completed_at,    '%Y-%m-%d %H:%i:%s') AS completed_at,
  DATE_FORMAT(p.failed_at,       '%Y-%m-%d %H:%i:%s') AS failed_at,
  p.failure_reason, p.punches_returned, p.new_punches, p.duplicate_punches,
  DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
  DATE_FORMAT(p.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at`;

class BiomaxHistoricalPullRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.BIOMAX_HISTORICAL_PULL",
      code: `REPOSITORY.BIOMAX_HISTORICAL_PULL.${code}`,
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

  /* --------------------------------------------------------------- reads */

  async deviceById(biomax_device_id) {
    const rows = await this._q(
      "DEVICE",
      `SELECT bd.biomax_device_id, bd.dev_id, bd.label,
              EXISTS (SELECT 1 FROM biomax_device_assignment a
                       WHERE a.biomax_device_id = bd.biomax_device_id AND a.effective_to IS NULL) AS has_open_period
         FROM biomax_device bd WHERE bd.biomax_device_id = ?`,
      [biomax_device_id]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  list({ dev_id, status, limit } = {}) {
    const where = [];
    const params = [];
    if (dev_id) {
      where.push("p.dev_id = ?");
      params.push(dev_id);
    }
    if (status) {
      where.push("p.status = ?");
      params.push(status);
    }
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    return this._q(
      "LIST",
      `SELECT ${PULL_COLUMNS},
              (SELECT COUNT(*) FROM biomax_command_result_block b
                WHERE b.biomax_historical_pull_id = p.biomax_historical_pull_id) AS blocks_received
         FROM biomax_historical_pull p
         JOIN biomax_device d ON d.biomax_device_id = p.biomax_device_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY p.requested_at DESC, p.biomax_historical_pull_id DESC
        LIMIT ?`,
      params
    );
  }

  async getById(biomax_historical_pull_id) {
    const rows = await this._q(
      "GET",
      `SELECT ${PULL_COLUMNS}
         FROM biomax_historical_pull p
         JOIN biomax_device d ON d.biomax_device_id = p.biomax_device_id
        WHERE p.biomax_historical_pull_id = ?`,
      [biomax_historical_pull_id]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** The queued command for a pull - status and timing, never re-sent from here. */
  async commandFor(biomax_historical_pull_id) {
    const rows = await this._q(
      "COMMAND",
      `SELECT biomax_device_command_id, trans_id, dev_id, cmd_code, begin_time, end_time, status,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(sent_at,    '%Y-%m-%d %H:%i:%s') AS sent_at,
              sent_to_ip
         FROM biomax_device_command
        WHERE biomax_historical_pull_id = ?
        ORDER BY biomax_device_command_id ASC`,
      [biomax_historical_pull_id]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** Block summaries WITHOUT the bytes. */
  blocksFor(biomax_historical_pull_id) {
    return this._q(
      "BLOCKS",
      `SELECT biomax_command_result_block_id, blk_no, blk_len, content_length, body_len, body_sha256,
              cmd_return_code, match_status, duplicate_count, conflict_count, source_ip,
              DATE_FORMAT(received_at,      '%Y-%m-%d %H:%i:%s') AS received_at,
              DATE_FORMAT(last_received_at, '%Y-%m-%d %H:%i:%s') AS last_received_at
         FROM biomax_command_result_block
        WHERE biomax_historical_pull_id = ?
        ORDER BY blk_no ASC`,
      [biomax_historical_pull_id]
    );
  }

  /** Active pulls on the same device whose range touches [from, to]. */
  findActiveOverlapping(dev_id, requested_from, requested_to, connection) {
    return this._q(
      "OVERLAP",
      `SELECT biomax_historical_pull_id, status,
              DATE_FORMAT(requested_from, '%Y-%m-%d %H:%i:%s') AS requested_from,
              DATE_FORMAT(requested_to,   '%Y-%m-%d %H:%i:%s') AS requested_to
         FROM biomax_historical_pull
        WHERE dev_id = ?
          AND status IN ('REQUESTED', 'WAITING_DEVICE', 'RECEIVING')
          AND requested_from <= ? AND requested_to >= ?`,
      [dev_id, requested_to, requested_from],
      connection
    );
  }

  /* -------------------------------------------------------------- writes */

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

  async insertPull(connection, { biomax_device_id, dev_id, requested_from, requested_to, trans_id, requested_by }) {
    const r = await this._q(
      "INSERT_PULL",
      `INSERT INTO biomax_historical_pull
         (biomax_device_id, dev_id, requested_from, requested_to, status, trans_id, requested_by)
       VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?)`,
      [biomax_device_id, dev_id, requested_from, requested_to, trans_id, requested_by === undefined ? null : requested_by],
      connection
    );
    return Number(r.insertId);
  }

  async insertCommand(connection, { biomax_historical_pull_id, trans_id, dev_id, cmd_code, begin_time, end_time }) {
    const r = await this._q(
      "INSERT_COMMAND",
      `INSERT INTO biomax_device_command
         (biomax_historical_pull_id, trans_id, dev_id, cmd_code, begin_time, end_time, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [biomax_historical_pull_id, trans_id, dev_id, cmd_code, begin_time, end_time],
      connection
    );
    return Number(r.insertId);
  }
}

module.exports = (db) => new BiomaxHistoricalPullRepository(db);
module.exports.BiomaxHistoricalPullRepository = BiomaxHistoricalPullRepository;
