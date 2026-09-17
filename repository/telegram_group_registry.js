const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

const TABLE = "telegram_group_registry";

/**
 * The Telegram Group Registry table.
 *
 * SQL only: every rule - the Chat ID format, the category vocabulary, the
 * uniqueness message, the derived group type - is in the usecase and in
 * `constants/telegram_group_registry.js`. Nothing here decides anything.
 *
 * THE OUTLET IS JOINED, NEVER COPIED. `outlet_name` and `outlet_code` come
 * out of `outlets` on every read, so renaming an outlet renames it here too
 * and the registry holds no second copy of outlet data.
 *
 * GROUP TYPE IS NOT SELECTED because it is not stored; the usecase derives it
 * from `chat_id`.
 */
const COLUMNS = `
  g.telegram_group_id, g.group_name, g.chat_id, g.category, g.used_for,
  g.outlet_id, o.outlet_name, o.outlet_code, g.bot_is_admin, g.is_active,
  g.created_by, g.created_at, g.updated_by, g.updated_at`;

class TelegramGroupRegistryRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.TELEGRAM_GROUP_REGISTRY",
      code: `REPOSITORY.TELEGRAM_GROUP_REGISTRY.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  /** `tx` is optional: given one, the statement joins that transaction. */
  _query(code, sql, params, tx) {
    if (tx) return tx.query(sql, params);
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

  static _row(row) {
    if (!row) return null;
    return {
      telegram_group_id: row.telegram_group_id,
      group_name: row.group_name,
      chat_id: String(row.chat_id),
      category: row.category,
      used_for: row.used_for,
      outlet_id: row.outlet_id === null || row.outlet_id === undefined ? null : row.outlet_id,
      outlet_name: row.outlet_name || null,
      outlet_code: row.outlet_code || null,
      bot_is_admin: Boolean(row.bot_is_admin),
      is_active: Boolean(row.is_active),
      created_by: row.created_by === undefined ? null : row.created_by,
      created_at: row.created_at,
      updated_by: row.updated_by === undefined ? null : row.updated_by,
      updated_at: row.updated_at,
    };
  }

  /* --------------------------------------------------------------- reads */

  /**
   * The registry, newest first.
   *
   * `search` matches the group name, the Chat ID and Used For. `category`,
   * `outlet_id`, `bot_is_admin` and `is_active` each narrow the list and are
   * all optional; the usecase has already validated every one of them, so an
   * unknown category or a non-boolean flag never reaches here.
   *
   * `outlet_id` of the string "none" means the company-wide groups - the rows
   * with NO outlet - which is a filter a plain `outlet_id = ?` cannot express.
   */
  async getAll({ search, category, outlet_id, bot_is_admin, is_active } = {}) {
    const where = [];
    const params = [];
    if (category) {
      where.push("g.category = ?");
      params.push(category);
    }
    if (outlet_id === "none") {
      where.push("g.outlet_id IS NULL");
    } else if (outlet_id !== undefined && outlet_id !== null) {
      where.push("g.outlet_id = ?");
      params.push(outlet_id);
    }
    if (bot_is_admin !== undefined && bot_is_admin !== null) {
      where.push("g.bot_is_admin = ?");
      params.push(bot_is_admin ? 1 : 0);
    }
    if (is_active !== undefined && is_active !== null) {
      where.push("g.is_active = ?");
      params.push(is_active ? 1 : 0);
    }
    if (search) {
      where.push("(g.group_name LIKE ? OR g.chat_id LIKE ? OR g.used_for LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const rows = await this._query(
      "GET_ALL",
      `SELECT ${COLUMNS}
         FROM ${TABLE} g
         LEFT JOIN outlets o ON o.outlet_id = g.outlet_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY g.telegram_group_id DESC`,
      params
    );
    return (rows || []).map(TelegramGroupRegistryRepository._row);
  }

  async getById(telegram_group_id) {
    const rows = await this._query(
      "GET_BY_ID",
      `SELECT ${COLUMNS}
         FROM ${TABLE} g
         LEFT JOIN outlets o ON o.outlet_id = g.outlet_id
        WHERE g.telegram_group_id = ?`,
      [telegram_group_id]
    );
    return TelegramGroupRegistryRepository._row(rows && rows[0]);
  }

  /**
   * The row holding this Chat ID, or null.
   *
   * `excludeId` is what makes EDITING WORK: a record being updated always
   * matches its own Chat ID, and without excluding itself every save of an
   * unchanged group would be refused as a duplicate.
   */
  async getByChatId(chat_id, excludeId = null) {
    const params = [String(chat_id)];
    let sql = `SELECT g.telegram_group_id, g.group_name, g.chat_id FROM ${TABLE} g WHERE g.chat_id = ?`;
    if (excludeId !== null && excludeId !== undefined) {
      sql += " AND g.telegram_group_id <> ?";
      params.push(excludeId);
    }
    const rows = await this._query("GET_BY_CHAT_ID", sql, params);
    return (rows && rows[0]) || null;
  }

  async outletExists(outlet_id) {
    const rows = await this._query(
      "OUTLET_EXISTS",
      "SELECT outlet_id FROM outlets WHERE outlet_id = ?",
      [outlet_id]
    );
    return Boolean(rows && rows.length);
  }

  /* -------------------------------------------------------------- writes */

  async create(row) {
    const res = await this._query(
      "CREATE",
      `INSERT INTO ${TABLE}
         (group_name, chat_id, category, used_for, outlet_id, bot_is_admin, is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.group_name,
        row.chat_id,
        row.category,
        row.used_for,
        row.outlet_id === undefined ? null : row.outlet_id,
        row.bot_is_admin ? 1 : 0,
        row.is_active === false ? 0 : 1,
        row.created_by === undefined ? null : row.created_by,
        row.created_by === undefined ? null : row.created_by,
      ]
    );
    return { code: 200, telegram_group_id: res.insertId };
  }

  /** Only the fields present in `fields` are written. */
  async update(telegram_group_id, fields, updated_by = null, { tx } = {}) {
    const sets = [];
    const values = [];
    for (const column of ["group_name", "chat_id", "category", "used_for", "outlet_id"]) {
      if (fields[column] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(fields[column]);
      }
    }
    for (const flag of ["bot_is_admin", "is_active"]) {
      if (fields[flag] !== undefined) {
        sets.push(`${flag} = ?`);
        values.push(fields[flag] ? 1 : 0);
      }
    }
    if (sets.length === 0) return { code: 200, affectedRows: 0 };
    sets.push("updated_by = ?");
    values.push(updated_by);
    values.push(telegram_group_id);
    const res = await this._query(
      "UPDATE",
      `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE telegram_group_id = ?`,
      values,
      tx
    );
    return { code: 200, affectedRows: res.affectedRows };
  }

  /**
   * One transaction, same shape as every other repository's. Phase 3C uses
   * it so the "may this group be deleted" check and the delete cannot be
   * separated by a claim opening between them.
   */
  async withTransaction(fn) {
    const connection = await getConnectionAsync(this.db);
    const tx = { query: (sql, params) => queryAsync(connection, sql, params) };
    try {
      await beginTransactionAsync(connection);
      const result = await fn(tx);
      await commitAsync(connection);
      return result;
    } catch (err) {
      await rollbackAsync(connection);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * LOCK THIS REGISTRY ROW FOR THE TRANSACTION, and lock it for WRITING.
   *
   * This is the lock that stops new children appearing, and it does it
   * through InnoDB's own foreign-key rules rather than through anything this
   * code does: inserting a row that references a parent takes a SHARED lock
   * on that parent row to check the constraint, and a shared lock cannot be
   * taken while somebody else holds this exclusive one. So a mapping or a
   * claim being created for this group waits here, behind the guard, instead
   * of appearing between the guard's count and the write that follows it.
   *
   * It does NOT cover an existing child row being UPDATED - a CLOSED claim
   * reopened in place never touches the parent - which is why the claim rows
   * are locked separately.
   */
  async lockForUpdate(telegram_group_id, { tx } = {}) {
    const rows = await this._query(
      "LOCK-FOR-UPDATE",
      `SELECT telegram_group_id, chat_id FROM ${TABLE} WHERE telegram_group_id = ? FOR UPDATE`,
      [telegram_group_id],
      tx
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async delete(telegram_group_id, { tx } = {}) {
    const res = await this._query(
      "DELETE",
      `DELETE FROM ${TABLE} WHERE telegram_group_id = ?`,
      [telegram_group_id],
      tx
    );
    return { code: 200, affectedRows: res.affectedRows };
  }
}

module.exports = (db) => new TelegramGroupRegistryRepository(db);
module.exports.TelegramGroupRegistryRepository = TelegramGroupRegistryRepository;
