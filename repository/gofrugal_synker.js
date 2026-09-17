const logger = require("../utils/logger");

const BATCH_SIZE = 1000;
// Allow letters, digits, underscore, space, hyphen, dot (common in column names). No backtick.
const IDENTIFIER_REGEX = /^[a-zA-Z0-9_\s.\-]+$/;

function escapeIdentifier(name) {
  if (typeof name !== "string" || !name.length) {
    throw new Error("Identifier cannot be empty");
  }
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid identifier (allowed: letters, digits, underscore, space, hyphen, dot): ${name}`);
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

class GofrugalSynkerRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Create table if not exists.
   * @param {string} tableName - Safe table name
   * @param {Array<{name: string, type: string, primaryKey?: boolean, autoIncrement?: boolean, nullable?: boolean}>} tableConfig - Column definitions
   * @param {string[]} uniqueKeys - Column names that form the unique key (required for ON DUPLICATE KEY UPDATE)
   */
  ensureTable(tableName, tableConfig, uniqueKeys) {
    return new Promise((resolve, reject) => {
      if (!tableName || !tableConfig || !Array.isArray(tableConfig) || tableConfig.length === 0) {
        return reject(new Error("table_name and table_config (non-empty) are required"));
      }
      if (!uniqueKeys || !Array.isArray(uniqueKeys) || uniqueKeys.length === 0) {
        return reject(new Error("unique_keys (at least one column) is required for upsert"));
      }

      const escapedTable = escapeIdentifier(tableName);
      // Build column defs without PRIMARY KEY on columns - we use unique_keys as the table key
      // so that composite unique_keys (e.g. PR_NO + SNO) define one row, not a single column.
      const columnDefs = tableConfig.map((col) => {
        const escaped = escapeIdentifier(col.name);
        let def = `${escaped} ${col.type || "VARCHAR(255)"}`;
        if (col.autoIncrement) def += " AUTO_INCREMENT";
        if (col.nullable === false) def += " NOT NULL";
        return def;
      });

      const uniqueKeyCols = uniqueKeys.map((k) => escapeIdentifier(k)).join(", ");
      // Use unique_keys as PRIMARY KEY so one row per (key1, key2, ...). Do not add
      // single-column PRIMARY KEY from table_config, which would allow only one row per PR_NO.
      columnDefs.push(`PRIMARY KEY (${uniqueKeyCols})`);

      const sql = `CREATE TABLE IF NOT EXISTS ${escapedTable} (${columnDefs.join(", ")})`;
      this.db.query(sql, (err) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.GOFRUGAL_SYNKER",
            code: "REPOSITORY.GOFRUGAL_SYNKER.CREATE_TABLE",
            description: err.toString(),
            category: "",
            ref: { tableName, sql }
          });
          return reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * The columns of the table's PRIMARY KEY, in key order.
   *
   * This is the key the upsert below ACTUALLY matches on, which is not
   * necessarily the `unique_keys` of the request: ensureTable is a CREATE
   * TABLE IF NOT EXISTS, so the key is fixed at creation and a later request
   * asking for a different one changes nothing. Reading it back is how that
   * disagreement becomes visible instead of silently mis-keying every row.
   *
   * Returns [] for a table with no primary key at all - which is worse than a
   * wrong one, because then ON DUPLICATE KEY UPDATE never matches anything
   * and every sync inserts another copy of the same source row.
   */
  getPrimaryKeyColumns(tableName) {
    return new Promise((resolve, reject) => {
      if (!tableName) return reject(new Error("table_name is required"));
      const escapedTable = escapeIdentifier(tableName);
      this.db.query(
        `SHOW KEYS FROM ${escapedTable} WHERE Key_name = 'PRIMARY'`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GOFRUGAL_SYNKER",
              code: "REPOSITORY.GOFRUGAL_SYNKER.SHOW_KEYS",
              description: err.toString(),
              category: "",
              ref: { tableName }
            });
            return reject(err);
          }
          const cols = (rows || [])
            .slice()
            .sort(
              (a, b) =>
                Number(a.Seq_in_index ?? a.seq_in_index ?? 0) -
                Number(b.Seq_in_index ?? b.seq_in_index ?? 0)
            )
            .map((r) => r.Column_name ?? r.column_name)
            .filter((c) => c != null);
          resolve(cols);
        }
      );
    });
  }

  /**
   * How many rows the table holds, and how many DISTINCT values of the key
   * the sender believes identifies a source row.
   *
   * When those two numbers differ, the table is holding more than one row per
   * source row: the upsert has been inserting copies instead of updating,
   * which is exactly what an edited GRN looks like when it "does not reflect"
   * - the new values are in the table, in a row nothing reads.
   */
  countRowsByKeys(tableName, uniqueKeys) {
    return new Promise((resolve, reject) => {
      if (!tableName) return reject(new Error("table_name is required"));
      if (!uniqueKeys?.length) return reject(new Error("unique_keys is required"));
      const escapedTable = escapeIdentifier(tableName);
      const keyCols = uniqueKeys.map((k) => escapeIdentifier(k)).join(", ");
      this.db.query(
        `SELECT COUNT(*) AS total_rows,
                COUNT(DISTINCT ${keyCols}) AS distinct_keys
         FROM ${escapedTable}`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GOFRUGAL_SYNKER",
              code: "REPOSITORY.GOFRUGAL_SYNKER.COUNT_BY_KEYS",
              description: err.toString(),
              category: "",
              ref: { tableName }
            });
            return reject(err);
          }
          const row = (rows || [])[0] || {};
          resolve({
            total_rows: Number(row.total_rows ?? 0),
            distinct_keys: Number(row.distinct_keys ?? 0)
          });
        }
      );
    });
  }

  /**
   * Fetch existing rows from the table by unique key values.
   * @param {string} tableName
   * @param {string[]} uniqueKeys
   * @param {Array<Object>} tableItems - Rows containing unique key columns
   * @returns {Promise<Array<Object>>}
   */
  getExistingRows(tableName, uniqueKeys, tableItems) {
    return new Promise((resolve, reject) => {
      if (!tableName || !uniqueKeys?.length || !Array.isArray(tableItems) || tableItems.length === 0) {
        return resolve([]);
      }
      const escapedTable = escapeIdentifier(tableName);
      const keyCols = uniqueKeys.map((k) => escapeIdentifier(k)).join(", ");
      if (uniqueKeys.length === 1) {
        const col = escapeIdentifier(uniqueKeys[0]);
        const values = tableItems.map((r) => r[uniqueKeys[0]] ?? null).filter((v) => v != null);
        if (values.length === 0) return resolve([]);
        const placeholders = values.map(() => "?").join(", ");
        const sql = `SELECT * FROM ${escapedTable} WHERE ${col} IN (${placeholders})`;
        this.db.query(sql, values, (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GOFRUGAL_SYNKER",
              code: "REPOSITORY.GOFRUGAL_SYNKER.GET_EXISTING",
              description: err.toString(),
              category: "",
              ref: { tableName }
            });
            return reject(err);
          }
          resolve(rows || []);
        });
      } else {
        const placeholders = tableItems.map(() => "(" + uniqueKeys.map(() => "?").join(", ") + ")").join(", ");
        const values = tableItems.flatMap((row) => uniqueKeys.map((k) => row[k] ?? null));
        const sql = `SELECT * FROM ${escapedTable} WHERE (${keyCols}) IN (${placeholders})`;
        this.db.query(sql, values, (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GOFRUGAL_SYNKER",
              code: "REPOSITORY.GOFRUGAL_SYNKER.GET_EXISTING",
              description: err.toString(),
              category: "",
              ref: { tableName }
            });
            return reject(err);
          }
          resolve(rows || []);
        });
      }
    });
  }

  /**
   * Upsert rows in batches (INSERT ... ON DUPLICATE KEY UPDATE).
   * @param {string} tableName
   * @param {string[]} columns - Column names (order must match table_items)
   * @param {Array<Object>} tableItems - Array of row objects (keys = column names)
   * @param {string[]} uniqueKeys - Columns that form the unique key
   */
  upsertBatch(tableName, columns, tableItems, uniqueKeys) {
    return new Promise((resolve, reject) => {
      if (!tableName || !columns?.length || !Array.isArray(tableItems)) {
        return reject(new Error("table_name, columns and table_items are required"));
      }
      if (!uniqueKeys?.length) {
        return reject(new Error("unique_keys is required"));
      }

      const escapedTable = escapeIdentifier(tableName);
      const escapedCols = columns.map((c) => escapeIdentifier(c));
      const updateClause = columns
        .filter((c) => !uniqueKeys.includes(c))
        .map((c) => `${escapeIdentifier(c)} = VALUES(${escapeIdentifier(c)})`)
        .join(", ");

      if (!updateClause) {
        return reject(new Error("At least one non-unique column is required for update"));
      }

      const runBatch = (rows) => {
        return new Promise((res, rej) => {
          if (rows.length === 0) return res();
          // One (?,?,...) per row so all rows are inserted/upserted
          const oneRowPlaceholders = "(" + columns.map(() => "?").join(", ") + ")";
          const allPlaceholders = rows.map(() => oneRowPlaceholders).join(", ");
          const insertSql = `INSERT INTO ${escapedTable} (${escapedCols.join(", ")}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${updateClause}`;
          const values = rows.flatMap((row) => columns.map((col) => row[col] ?? null));
          this.db.query(insertSql, values, (err, result) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.GOFRUGAL_SYNKER",
                code: "REPOSITORY.GOFRUGAL_SYNKER.UPSERT",
                description: err.toString(),
                category: "",
                ref: { tableName, rowCount: rows.length }
              });
              return rej(err);
            }
            res(result);
          });
        });
      };

      const batches = [];
      for (let i = 0; i < tableItems.length; i += BATCH_SIZE) {
        batches.push(tableItems.slice(i, i + BATCH_SIZE));
      }

      (async () => {
        try {
          for (const batch of batches) {
            await runBatch(batch);
          }
          resolve({ inserted: tableItems.length });
        } catch (e) {
          reject(e);
        }
      })();
    });
  }

  /**
   * Drop a table if it exists.
   * @param {string} tableName - Table name (validated via escapeIdentifier)
   */
  deleteTable(tableName) {
    return new Promise((resolve, reject) => {
      if (!tableName || typeof tableName !== "string" || !tableName.trim()) {
        return reject(new Error("table_name is required"));
      }
      const escapedTable = escapeIdentifier(tableName.trim());
      const sql = `DROP TABLE IF EXISTS ${escapedTable}`;
      this.db.query(sql, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.GOFRUGAL_SYNKER",
            code: "REPOSITORY.GOFRUGAL_SYNKER.DELETE_TABLE",
            description: err.toString(),
            category: "",
            ref: { tableName, sql }
          });
          return reject(err);
        }
        resolve({ affectedRows: result?.affectedRows ?? 0 });
      });
    });
  }
}

module.exports = (db) => {
  return new GofrugalSynkerRepository(db);
};
