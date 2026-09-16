const logger = require("../utils/logger");
const {
  MAPPING_TARGET_SOURCE,
  TARGETED_MAPPING_TYPES,
} = require("../constants/telegram_group_mapping");

const TABLE = "telegram_group_mapping";

/**
 * Telegram Group Mapping - SQL only.
 *
 * Every rule - which types exist, what the sentinel means, whether a target
 * is valid, who matches - is in `constants/telegram_group_mapping.js`,
 * `utils/telegram_group_mapping.js` and the usecase. Nothing here decides
 * anything, the way `repository/telegram_group_registry.js` decides nothing.
 *
 * ===================================== A BOUNDED NUMBER OF QUERIES =========
 *
 * The mapping screen for one group is FOUR reads, whatever it contains:
 *
 *   1. the group's mapping rows
 *   2. one read per master actually referenced, to resolve target names and
 *      state - at most three, and only for the types present
 *   3. ONE employee snapshot
 *   4. ONE active-Telegram-identity read over that snapshot
 *
 * It is deliberately NOT a query per mapping and NOT a query per employee.
 * Matching a few hundred employees against a handful of rules is arithmetic;
 * paying a database round trip for each combination would be slower, and -
 * worse - each round trip is a fresh chance for the answer to change
 * underneath a half-built screen.
 *
 * ================================== NOTHING SENSITIVE IS SELECTED ==========
 *
 * The employee snapshot lists the columns it needs and no others. Not
 * `SELECT *`: the employee table carries salary, bank, PAN, PF/ESI, Aadhaar
 * and mobile columns, and the safest way for a mapping screen never to leak
 * one is for the query never to ask for it. The Telegram read returns an
 * employee id and nothing else - no username, no user id, no chat id.
 */
class TelegramGroupMappingRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.TELEGRAM_GROUP_MAPPING",
      code: `REPOSITORY.TELEGRAM_GROUP_MAPPING.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          return reject(err);
        }
        resolve(rows);
      });
    });
  }

  /* --------------------------------------------------------------- reads */

  /** One group's mapping rows, oldest first so the list is stable. */
  async getByGroup(telegram_group_id) {
    const rows = await this._query(
      "GET_BY_GROUP",
      `SELECT telegram_group_mapping_id, telegram_group_id, mapping_type, target_id,
              created_by, created_at
         FROM ${TABLE}
        WHERE telegram_group_id = ?
        ORDER BY telegram_group_mapping_id ASC`,
      [telegram_group_id]
    );
    return (rows || []).map((row) => ({
      telegram_group_mapping_id: Number(row.telegram_group_mapping_id),
      telegram_group_id: Number(row.telegram_group_id),
      mapping_type: row.mapping_type,
      target_id: Number(row.target_id),
      created_by: row.created_by === undefined ? null : row.created_by,
      created_at: row.created_at,
    }));
  }

  /**
   * One mapping, but ONLY if it belongs to this group.
   *
   * The group id is part of the WHERE rather than something checked
   * afterwards, so a caller cannot reach another group's mapping by guessing
   * an id - and a caller who guesses gets "not found on this group", which
   * tells them nothing about whether the id exists elsewhere.
   */
  async getByIdForGroup(telegram_group_id, telegram_group_mapping_id) {
    const rows = await this._query(
      "GET_BY_ID_FOR_GROUP",
      `SELECT telegram_group_mapping_id, telegram_group_id, mapping_type, target_id
         FROM ${TABLE}
        WHERE telegram_group_id = ? AND telegram_group_mapping_id = ?`,
      [telegram_group_id, telegram_group_mapping_id]
    );
    const row = rows && rows[0];
    if (!row) return null;
    return {
      telegram_group_mapping_id: Number(row.telegram_group_mapping_id),
      telegram_group_id: Number(row.telegram_group_id),
      mapping_type: row.mapping_type,
      target_id: Number(row.target_id),
    };
  }

  async findDuplicate(telegram_group_id, mapping_type, target_id) {
    const rows = await this._query(
      "FIND_DUPLICATE",
      `SELECT telegram_group_mapping_id
         FROM ${TABLE}
        WHERE telegram_group_id = ? AND mapping_type = ? AND target_id = ?`,
      [telegram_group_id, mapping_type, target_id]
    );
    return (rows && rows[0]) || null;
  }

  /**
   * Resolve the targets a group's mappings name, one query per master used.
   *
   * Returns `Map<type, Map<id, {name, active}>>`. A target that is absent
   * from the map DOES NOT EXIST; one present with `active: false` exists and
   * is retired. The caller needs both answers and they are different states.
   *
   * A NULL active column counts as ACTIVE. Several master rows predate the
   * column, and calling those inactive would decorate long-standing correct
   * mappings with a warning - the same conclusion, for the same reason, that
   * `repository/report_template.js#resolveLookupIds` reached.
   */
  async resolveTargets(idsByType) {
    const out = new Map();
    const types = TARGETED_MAPPING_TYPES.filter((type) => {
      const ids = idsByType && idsByType[type];
      return Array.isArray(ids) && ids.length > 0;
    });

    await Promise.all(
      types.map(async (type) => {
        const source = MAPPING_TARGET_SOURCE[type];
        const ids = [
          ...new Set(
            (idsByType[type] || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
          ),
        ];
        if (ids.length === 0) return;
        const rows = await this._query(
          `RESOLVE_TARGETS_${type}`,
          `SELECT ${source.id} AS id, ${source.name} AS name, ${source.active} AS active
             FROM ${source.table}
            WHERE ${source.id} IN (?)`,
          [ids]
        );
        const found = new Map();
        for (const row of rows || []) {
          found.set(Number(row.id), {
            name: row.name === null || row.name === undefined ? null : String(row.name),
            active: row.active === null || Number(row.active) === 1,
          });
        }
        out.set(type, found);
      })
    );

    return out;
  }

  /**
   * THE EMPLOYEE SNAPSHOT - one read, every employee, safe columns only.
   *
   * WHY NO `WHERE`, WHEN MOST CALLS WANT ONE OUTLET. Because a single group
   * can carry an ALL_EMPLOYEES mapping beside three targeted ones, and the
   * union has to be derived from one population anyway. At a few hundred
   * employees this is a small table scan once per request, against the
   * alternative of a query per mapping whose results could disagree with each
   * other. When the company is large enough for that to stop being true, the
   * fix is a narrowing WHERE built from the mappings - not a cache.
   *
   * `date_of_joining` and `resignation_date` are here because `employedOn()`
   * reads them. They are dates of employment, not personal data, and no
   * salary, bank, identity-document or contact column is selected at all.
   */
  async getEmployeeSnapshot() {
    const rows = await this._query(
      "EMPLOYEE_SNAPSHOT",
      `SELECT ne.employee_id,
              ne.employee_name,
              ne.store_id,
              ne.designation_id,
              ne.department_id,
              ne.status,
              ne.date_of_joining,
              ne.resignation_date,
              o.outlet_name,
              d.designation_name,
              dp.department_name
         FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN department dp ON dp.department_id = ne.department_id
        ORDER BY ne.employee_name ASC, ne.employee_id ASC`,
      []
    );
    return (rows || []).map((row) => ({
      employee_id: Number(row.employee_id),
      employee_name: row.employee_name,
      store_id: row.store_id === null || row.store_id === undefined ? null : Number(row.store_id),
      designation_id:
        row.designation_id === null || row.designation_id === undefined
          ? null
          : Number(row.designation_id),
      department_id:
        row.department_id === null || row.department_id === undefined
          ? null
          : Number(row.department_id),
      status: row.status,
      date_of_joining: row.date_of_joining,
      resignation_date: row.resignation_date,
      outlet_name: row.outlet_name || null,
      designation_name: row.designation_name || null,
      department_name: row.department_name || null,
    }));
  }

  /**
   * WHICH OF THESE EMPLOYEES HAVE A LIVE TELEGRAM IDENTITY. One query.
   *
   * `disconnected_at IS NULL` is what "active" means in
   * `employee_telegram_identity` - the Phase 2 table keeps the history and
   * stamps the old row rather than deleting it, so an employee who
   * disconnected has rows here and must still answer No.
   *
   * IT RETURNS EMPLOYEE IDS AND NOTHING ELSE. Not the Telegram user id, not
   * the private chat id, not the username, not the verified mobile. The
   * screen asks one yes/no question and this answers exactly that question,
   * so there is no sensitive value in the response for a later change to
   * accidentally forward.
   */
  async getConnectedEmployeeIds(employeeIds) {
    const ids = [
      ...new Set(
        (Array.isArray(employeeIds) ? employeeIds : [])
          .map(Number)
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];
    if (ids.length === 0) return new Set();
    const rows = await this._query(
      "CONNECTED_EMPLOYEE_IDS",
      `SELECT employee_id
         FROM employee_telegram_identity
        WHERE disconnected_at IS NULL AND employee_id IN (?)`,
      [ids]
    );
    return new Set((rows || []).map((row) => Number(row.employee_id)));
  }

  /* -------------------------------------------------------------- writes */

  async create({ telegram_group_id, mapping_type, target_id, created_by = null }) {
    const res = await this._query(
      "CREATE",
      `INSERT INTO ${TABLE} (telegram_group_id, mapping_type, target_id, created_by)
       VALUES (?, ?, ?, ?)`,
      [telegram_group_id, mapping_type, target_id, created_by === undefined ? null : created_by]
    );
    return { telegram_group_mapping_id: res.insertId };
  }

  /**
   * Delete, scoped to the group in the same statement.
   *
   * `affectedRows === 0` therefore means "not this group's mapping" whether
   * the id is unknown or belongs to somebody else, which is the answer the
   * caller should give either way.
   */
  async delete(telegram_group_id, telegram_group_mapping_id) {
    const res = await this._query(
      "DELETE",
      `DELETE FROM ${TABLE} WHERE telegram_group_id = ? AND telegram_group_mapping_id = ?`,
      [telegram_group_id, telegram_group_mapping_id]
    );
    return { affectedRows: res.affectedRows };
  }
}

module.exports = (db) => new TelegramGroupMappingRepository(db);
module.exports.TelegramGroupMappingRepository = TelegramGroupMappingRepository;
module.exports.TABLE = TABLE;
