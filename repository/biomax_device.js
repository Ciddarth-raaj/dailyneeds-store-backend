const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * The Biomax device registry: devices, their effective-dated location
 * assignments, and the append-only event history.
 *
 * Nothing here touches a punch. Registering, moving or deactivating a
 * terminal changes which assignment period a punch's io_time falls into
 * when it is READ (R17); no punch row and no derived row is ever rewritten
 * by anything in this file.
 *
 * All DATETIMEs go out as strings (R4) and come in as strings the usecase
 * has already validated to 'YYYY-MM-DD HH:MM:SS'.
 */
class BiomaxDeviceRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.BIOMAX_DEVICE",
      code: `REPOSITORY.BIOMAX_DEVICE.${code}`,
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

  /**
   * Every device with its CURRENT assignment (the open period, if any) and
   * a punch count for today. "Status" is derived: Active when an open
   * period exists, Inactive otherwise.
   */
  list() {
    return this._q(
      "LIST",
      `SELECT bd.biomax_device_id, bd.dev_id, bd.label, bd.notes,
              DATE_FORMAT(bd.first_seen_at, '%Y-%m-%d %H:%i:%s') AS first_seen_at,
              DATE_FORMAT(bd.last_seen_at,  '%Y-%m-%d %H:%i:%s') AS last_seen_at,
              DATE_FORMAT(bd.last_punch_at, '%Y-%m-%d %H:%i:%s') AS last_punch_at,
              cur.biomax_device_assignment_id AS current_assignment_id,
              cur.outlet_id                   AS current_outlet_id,
              o.outlet_name                   AS current_outlet,
              o.outlet_code                   AS current_outlet_code,
              DATE_FORMAT(cur.effective_from, '%Y-%m-%d %H:%i:%s') AS current_effective_from,
              DATE_FORMAT(lastp.effective_to, '%Y-%m-%d %H:%i:%s') AS inactive_since,
              CASE WHEN cur.biomax_device_assignment_id IS NULL THEN 'INACTIVE' ELSE 'ACTIVE' END AS status,
              (SELECT COUNT(*) FROM biomax_punch p
                WHERE p.dev_id = bd.dev_id AND p.punch_date = CURDATE()) AS punches_today
         FROM biomax_device bd
         LEFT JOIN biomax_device_assignment cur
                ON cur.biomax_device_id = bd.biomax_device_id AND cur.effective_to IS NULL
         LEFT JOIN outlets o ON o.outlet_id = cur.outlet_id
         LEFT JOIN biomax_device_assignment lastp
                ON lastp.biomax_device_assignment_id = (
                     SELECT a.biomax_device_assignment_id FROM biomax_device_assignment a
                      WHERE a.biomax_device_id = bd.biomax_device_id AND a.effective_to IS NOT NULL
                      ORDER BY a.effective_to DESC LIMIT 1)
        ORDER BY bd.label ASC`,
      []
    );
  }

  async getById(biomax_device_id) {
    const rows = await this._q(
      "GET-BY-ID",
      `SELECT biomax_device_id, dev_id, label, notes,
              DATE_FORMAT(first_seen_at, '%Y-%m-%d %H:%i:%s') AS first_seen_at,
              DATE_FORMAT(last_seen_at,  '%Y-%m-%d %H:%i:%s') AS last_seen_at,
              DATE_FORMAT(last_punch_at, '%Y-%m-%d %H:%i:%s') AS last_punch_at,
              created_by, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM biomax_device WHERE biomax_device_id = ?`,
      [biomax_device_id]
    );
    return rows[0] || null;
  }

  async getByDevId(dev_id) {
    const rows = await this._q(
      "GET-BY-DEV-ID",
      "SELECT biomax_device_id, dev_id, label FROM biomax_device WHERE dev_id = ?",
      [dev_id]
    );
    return rows[0] || null;
  }

  /** All assignment periods of a device, newest first. */
  assignments(biomax_device_id, connection) {
    return this._q(
      "ASSIGNMENTS",
      `SELECT a.biomax_device_assignment_id, a.biomax_device_id, a.outlet_id,
              o.outlet_name, o.outlet_code,
              DATE_FORMAT(a.effective_from, '%Y-%m-%d %H:%i:%s') AS effective_from,
              DATE_FORMAT(a.effective_to,   '%Y-%m-%d %H:%i:%s') AS effective_to,
              a.note, a.created_by, DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM biomax_device_assignment a
         LEFT JOIN outlets o ON o.outlet_id = a.outlet_id
        WHERE a.biomax_device_id = ?
        ORDER BY a.effective_from DESC`,
      [biomax_device_id],
      connection
    );
  }

  events(biomax_device_id) {
    return this._q(
      "EVENTS",
      `SELECT ev.biomax_device_event_id, ev.event_type, ev.detail_json, ev.actor_employee_id,
              e.employee_name AS actor_name,
              DATE_FORMAT(ev.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM biomax_device_event ev
         LEFT JOIN new_employee e ON e.employee_id = ev.actor_employee_id
        WHERE ev.biomax_device_id = ?
        ORDER BY ev.created_at DESC, ev.biomax_device_event_id DESC`,
      [biomax_device_id]
    );
  }

  /** Cloud IDs that have punched but have no registry row. */
  unregisteredSeen() {
    return this._q(
      "UNREGISTERED-SEEN",
      `SELECT p.dev_id, COUNT(*) AS punches,
              DATE_FORMAT(MIN(p.io_time), '%Y-%m-%d %H:%i:%s') AS first_punch,
              DATE_FORMAT(MAX(p.io_time), '%Y-%m-%d %H:%i:%s') AS last_punch,
              MAX(p.source_ip) AS last_source_ip
         FROM biomax_punch p
         LEFT JOIN biomax_device bd ON bd.dev_id = p.dev_id
        WHERE bd.biomax_device_id IS NULL
        GROUP BY p.dev_id ORDER BY last_punch DESC`,
      []
    );
  }

  /** Latest punch io_time for a device, for the "closing before punches" guard. */
  async lastPunchIoTime(dev_id, connection) {
    const rows = await this._q(
      "LAST-PUNCH",
      "SELECT DATE_FORMAT(MAX(io_time), '%Y-%m-%d %H:%i:%s') AS last_io_time FROM biomax_punch WHERE dev_id = ?",
      [dev_id],
      connection
    );
    return rows[0] ? rows[0].last_io_time : null;
  }

  async outletExists(outlet_id, connection) {
    const rows = await this._q(
      "OUTLET-EXISTS",
      "SELECT outlet_id FROM outlets WHERE outlet_id = ?",
      [outlet_id],
      connection
    );
    return rows.length > 0;
  }

  /* -------------------------------------------------------------- writes */

  /**
   * Run `work(connection)` inside one transaction. Everything that changes a
   * device and its periods goes through here so the event row and the data
   * change land together or not at all.
   */
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

  async insertDevice(connection, { dev_id, label, notes, created_by }) {
    const r = await queryAsync(
      connection,
      "INSERT INTO biomax_device (dev_id, label, notes, created_by) VALUES (?, ?, ?, ?)",
      [dev_id, label, notes || null, created_by || null]
    );
    return Number(r.insertId);
  }

  updateDeviceFields(connection, biomax_device_id, fields) {
    return queryAsync(connection, "UPDATE biomax_device SET ? WHERE biomax_device_id = ?", [
      fields,
      biomax_device_id,
    ]);
  }

  async insertAssignment(connection, { biomax_device_id, outlet_id, effective_from, effective_to, note, created_by }) {
    const r = await queryAsync(
      connection,
      `INSERT INTO biomax_device_assignment
         (biomax_device_id, outlet_id, effective_from, effective_to, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [biomax_device_id, outlet_id, effective_from, effective_to || null, note || null, created_by || null]
    );
    return Number(r.insertId);
  }

  closeAssignment(connection, biomax_device_assignment_id, effective_to) {
    return queryAsync(
      connection,
      "UPDATE biomax_device_assignment SET effective_to = ? WHERE biomax_device_assignment_id = ? AND effective_to IS NULL",
      [effective_to, biomax_device_assignment_id]
    );
  }

  insertEvent(connection, { biomax_device_id, event_type, detail, actor_employee_id }) {
    return queryAsync(
      connection,
      `INSERT INTO biomax_device_event (biomax_device_id, event_type, detail_json, actor_employee_id)
       VALUES (?, ?, ?, ?)`,
      [biomax_device_id, event_type, JSON.stringify(detail || {}), actor_employee_id || null]
    );
  }
}

module.exports = (db) => new BiomaxDeviceRepository(db);
module.exports.BiomaxDeviceRepository = BiomaxDeviceRepository;
