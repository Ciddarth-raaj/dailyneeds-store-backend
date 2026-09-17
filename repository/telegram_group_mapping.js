const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const {
  MAPPING_TARGET_SOURCE,
  TARGETED_MAPPING_TYPES,
  RULE_DIMENSIONS,
  RULE_DIMENSION,
  ANY_TARGET_ID,
} = require("../constants/telegram_group_mapping");

/** The three rule columns, as a SELECT list fragment. One definition. */
const RULE_COLUMNS = RULE_DIMENSIONS.map((d) => RULE_DIMENSION[d].column);

/** 0 for anything that is not a usable positive id - the unrestricted sentinel. */
const ruleId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : ANY_TARGET_ID;
};

/**
 * The stored rule, read off a row. Shape matches `ruleOf`'s input exactly.
 *
 * NULL SURVIVES AS NULL. During the expand/contract transition a row written
 * by the OLD process has no composite rule at all, and `ruleOf` decodes such
 * a row from its legacy pair instead. Coercing NULL to 0 here would turn
 * "this row is legacy" into "every dimension unrestricted" - the widest rule
 * there is - so the sentinel is applied only to rows that actually carry one.
 */
const ruleFromRow = (row) => {
  const out = {};
  const legacy = RULE_DIMENSIONS.every((dimension) => {
    const raw = row[RULE_DIMENSION[dimension].column];
    return raw === null || raw === undefined;
  });
  for (const dimension of RULE_DIMENSIONS) {
    const column = RULE_DIMENSION[dimension].column;
    out[column] = legacy ? null : ruleId(row[column]);
  }
  return out;
};

/**
 * THE BACKWARD-COMPATIBLE SHADOW a new row leaves for the old process.
 *
 * Until the contract migration drops them, `mapping_type` and `target_id` are
 * NOT NULL and the old code still reads them, so every row this code writes
 * has to carry a pair that the old matcher handles SAFELY.
 *
 *   nothing narrowed -> ALL_EMPLOYEES, 0   exact. Old code agrees completely.
 *   one dimension    -> that type, its id  exact. Old code agrees completely.
 *   two or three     -> COMPOSITE, 0       NEUTRAL. There is no honest legacy
 *                                          pair for a multi-level rule, and
 *                                          both lossy ones BROADEN it -
 *                                          "Cashiers at Moolakulam" would
 *                                          become every cashier, or everybody
 *                                          at that outlet. The old matcher
 *                                          does not recognise COMPOSITE and
 *                                          so matches nobody, which
 *                                          under-reaches for a few minutes
 *                                          instead of telling real people to
 *                                          join a group they do not belong in.
 *
 * `target_id` for the COMPOSITE case is replaced with the row's own id
 * immediately after the insert, so `uq_tgm_group_type_target` - which this
 * migration deliberately keeps - stays satisfiable when one group carries
 * several multi-level rules. Nothing ever reads it as a target.
 */
const legacyShadowOf = (rule) => {
  const narrowed = RULE_DIMENSIONS.filter(
    (dimension) => ruleId(rule && rule[RULE_DIMENSION[dimension].column]) > ANY_TARGET_ID
  );
  if (narrowed.length === 0) {
    return { mapping_type: LEGACY_ALL_EMPLOYEES, target_id: ANY_TARGET_ID, composite: false };
  }
  if (narrowed.length === 1) {
    return {
      mapping_type: narrowed[0],
      target_id: ruleId(rule[RULE_DIMENSION[narrowed[0]].column]),
      composite: false,
    };
  }
  return { mapping_type: LEGACY_COMPOSITE, target_id: ANY_TARGET_ID, composite: true };
};

const LEGACY_ALL_EMPLOYEES = "ALL_EMPLOYEES";
/** Not a dimension - the neutral marker the old matcher cannot act on. */
const LEGACY_COMPOSITE = "COMPOSITE";

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
 * The mapping screen for one group is AT MOST SIX reads, whatever it
 * contains:
 *
 *   1  the group's mapping rows
 *  <=3 one read per master actually referenced, to resolve target names and
 *      state - only for the types present, so a group using outlets alone
 *      costs one
 *   1  ONE employee snapshot
 *   1  ONE active-Telegram-identity read over that snapshot
 *
 * `matched-employees` is at most four on the same basis - it resolves no
 * masters - plus one `getByIdForGroup` when `?mapping_id=` is given.
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

  /* --------------------------------------------------------------- reads */

  /** One group's mapping rows, oldest first so the list is stable. */
  async getByGroup(telegram_group_id) {
    const rows = await this._query(
      "GET_BY_GROUP",
      `SELECT telegram_group_mapping_id, telegram_group_id, mapping_type, target_id,
              ${RULE_COLUMNS.join(", ")}, created_by, created_at
         FROM ${TABLE}
        WHERE telegram_group_id = ?
        ORDER BY telegram_group_mapping_id ASC`,
      [telegram_group_id]
    );
    return (rows || []).map((row) => ({
      telegram_group_mapping_id: Number(row.telegram_group_mapping_id),
      telegram_group_id: Number(row.telegram_group_id),
      // BOTH SHAPES TRAVEL TOGETHER. `ruleOf` prefers the composite columns
      // and falls back to the legacy pair for a row the old process wrote
      // during the transition, so one decoder serves both.
      mapping_type: row.mapping_type,
      target_id: row.target_id === null || row.target_id === undefined ? null : Number(row.target_id),
      ...ruleFromRow(row),
      created_by: row.created_by === undefined ? null : row.created_by,
      created_at: row.created_at,
    }));
  }

  /**
   * EVERY mapping, with the registry group it belongs to. One query.
   *
   * Phase 3B needs the reverse of the Map screen's question: not "who does
   * this group require" but "which groups require this employee". That is
   * the same mapping rows read the other way round, so it is the same rows -
   * and the SAME matcher in `utils/telegram_group_mapping.js` is applied to
   * them, rather than a second rule written in SQL that could drift from the
   * one the Map screen shows.
   *
   * WHOLE TABLE, NO `WHERE` ON THE EMPLOYEE. A group has a handful of rules
   * and a company has a handful of groups; this is a small join read once
   * per employee screen. Filtering by dimension in SQL would mean encoding
   * the matching rule twice, and the copy that drifted would be the one
   * deciding who is required to join a real group.
   *
   * INACTIVE GROUPS ARE INCLUDED. They are not managed - readiness reports
   * INACTIVE_GROUP - but they must still be visible, because a requirement
   * that silently disappeared when somebody retired a group is a requirement
   * nobody can see is unmet.
   */
  async getAllMappingsWithGroups() {
    const rows = await this._query(
      "ALL_WITH_GROUPS",
      `SELECT m.telegram_group_mapping_id, m.telegram_group_id, m.mapping_type, m.target_id,
              ${RULE_COLUMNS.map((c) => `m.${c}`).join(", ")},
              g.group_name, g.chat_id, g.category, g.used_for, g.outlet_id,
              g.bot_is_admin, g.is_active
         FROM ${TABLE} m
         JOIN telegram_group_registry g ON g.telegram_group_id = m.telegram_group_id
        ORDER BY g.group_name ASC, m.telegram_group_mapping_id ASC`,
      []
    );
    return (rows || []).map((row) => ({
      telegram_group_mapping_id: Number(row.telegram_group_mapping_id),
      telegram_group_id: Number(row.telegram_group_id),
      mapping_type: row.mapping_type,
      target_id: row.target_id === null || row.target_id === undefined ? null : Number(row.target_id),
      ...ruleFromRow(row),
      group: {
        telegram_group_id: Number(row.telegram_group_id),
        group_name: row.group_name,
        chat_id: String(row.chat_id),
        category: row.category,
        used_for: row.used_for,
        outlet_id:
          row.outlet_id === null || row.outlet_id === undefined ? null : Number(row.outlet_id),
        bot_is_admin: Boolean(row.bot_is_admin),
        is_active: Boolean(row.is_active),
      },
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
      `SELECT telegram_group_mapping_id, telegram_group_id, mapping_type, target_id,
              ${RULE_COLUMNS.join(", ")}
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
      target_id: row.target_id === null || row.target_id === undefined ? null : Number(row.target_id),
      ...ruleFromRow(row),
    };
  }

  /**
   * Is this EXACT rule already on this group - all three dimensions equal.
   *
   * A pre-check only, so the user reads a sentence instead of a driver error.
   * `uq_tgm_group_rule` is what actually decides: two requests can both pass
   * this in the same instant.
   */
  async findDuplicateRule(telegram_group_id, rule) {
    const where = RULE_COLUMNS.map((c) => `${c} = ?`).join(" AND ");
    const rows = await this._query(
      "FIND_DUPLICATE_RULE",
      `SELECT telegram_group_mapping_id
         FROM ${TABLE}
        WHERE telegram_group_id = ? AND ${where}`,
      [telegram_group_id, ...RULE_COLUMNS.map((c) => ruleId(rule && rule[c]))]
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
   * ONE employee's matching columns. The same safe set as the snapshot.
   *
   * Phase 3B asks about a single employee - on their profile, or when a join
   * request arrives - and reading the whole company to answer that would be
   * a table scan per Telegram update. Same columns, same shape, one row, so
   * the shared matcher does not care which of the two it was handed.
   */
  async getEmployeeForMatching(employeeId) {
    const rows = await this._query(
      "EMPLOYEE_FOR_MATCHING",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id, ne.designation_id,
              ne.department_id, ne.status, ne.date_of_joining, ne.resignation_date
         FROM new_employee ne
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    const row = rows && rows[0];
    if (!row) return null;
    return {
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
    };
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

  /**
   * One transaction on one pooled connection, shaped exactly like
   * `repository/employee_master.js#withTransaction` so the same `tx` object
   * can be handed to any repository that takes one.
   *
   * Phase 3C added this. A mapping change is what decides who belongs in a
   * group, so the reconciliation job that acts on it must commit with it -
   * "write the mapping, then hope to queue the work" loses the work whenever
   * the process dies in between, and the mapping then silently manages
   * nobody.
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
      this._log("TRANSACTION", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * DUAL-WRITE: the composite rule AND the legacy shadow the old process
   * reads. See `legacyShadowOf` for why the shadow is exact for a
   * single-dimension rule and deliberately NEUTRAL for a multi-level one.
   *
   * The COMPOSITE case needs a second statement because its `target_id` is
   * the row's own auto-increment id, which does not exist until the insert
   * has run. It is the only thing keeping `uq_tgm_group_type_target` - which
   * the expand migration deliberately preserves for the old process -
   * satisfiable when one group carries several multi-level rules. It runs in
   * the SAME transaction as the insert, so no row is ever visible to another
   * connection carrying the placeholder.
   */
  async create({ telegram_group_id, rule, created_by = null }, { tx } = {}) {
    const shadow = legacyShadowOf(rule);
    const res = await this._query(
      "CREATE",
      `INSERT INTO ${TABLE}
         (telegram_group_id, mapping_type, target_id, ${RULE_COLUMNS.join(", ")}, created_by)
       VALUES (?, ?, ?, ${RULE_COLUMNS.map(() => "?").join(", ")}, ?)`,
      [
        telegram_group_id,
        shadow.mapping_type,
        shadow.target_id,
        ...RULE_COLUMNS.map((c) => ruleId(rule && rule[c])),
        created_by === undefined ? null : created_by,
      ],
      tx
    );
    if (shadow.composite) {
      await this._query(
        "CREATE-COMPOSITE-SHADOW",
        `UPDATE ${TABLE} SET target_id = telegram_group_mapping_id
          WHERE telegram_group_mapping_id = ?`,
        [res.insertId],
        tx
      );
    }
    return { telegram_group_mapping_id: res.insertId };
  }

  /**
   * Delete, scoped to the group in the same statement.
   *
   * `affectedRows === 0` therefore means "not this group's mapping" whether
   * the id is unknown or belongs to somebody else, which is the answer the
   * caller should give either way.
   */
  async delete(telegram_group_id, telegram_group_mapping_id, { tx } = {}) {
    const res = await this._query(
      "DELETE",
      `DELETE FROM ${TABLE} WHERE telegram_group_id = ? AND telegram_group_mapping_id = ?`,
      [telegram_group_id, telegram_group_mapping_id],
      tx
    );
    return { affectedRows: res.affectedRows };
  }

  /**
   * THE GROUP'S MAPPING ROWS, LOCKED FOR THE TRANSACTION.
   *
   * `countForGroup` is an ordinary read: it answers what was true a moment
   * ago, which is exactly the wrong thing for a guard. This takes write
   * locks on the rows it counts, so a mapping being deleted concurrently
   * cannot vanish out from under the decision either.
   *
   * New INSERTs are held by the parent-row lock the registry takes first -
   * InnoDB checks the foreign key by taking a shared lock on that parent,
   * and it cannot while the guard holds it exclusively.
   */
  async countForGroupForUpdate(telegram_group_id, { tx } = {}) {
    const rows = await this._query(
      "COUNT-FOR-GROUP-FOR-UPDATE",
      `SELECT telegram_group_mapping_id FROM ${TABLE}
        WHERE telegram_group_id = ? FOR UPDATE`,
      [telegram_group_id],
      tx
    );
    return rows ? rows.length : 0;
  }

  /** How many mappings a group carries - the registry delete guard reads it. */
  async countForGroup(telegram_group_id, { tx } = {}) {
    const rows = await this._query(
      "COUNT-FOR-GROUP",
      `SELECT COUNT(*) AS n FROM ${TABLE} WHERE telegram_group_id = ?`,
      [telegram_group_id],
      tx
    );
    return rows && rows[0] ? Number(rows[0].n) : 0;
  }
}

module.exports = (db) => new TelegramGroupMappingRepository(db);
module.exports.TelegramGroupMappingRepository = TelegramGroupMappingRepository;
module.exports.TABLE = TABLE;
module.exports.RULE_COLUMNS = RULE_COLUMNS;
module.exports.legacyShadowOf = legacyShadowOf;
