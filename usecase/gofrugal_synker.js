const logger = require("../utils/logger");

/**
 * Do the requested unique_keys and the table's real primary key agree?
 *
 * Compared as SETS, case-insensitively: MySQL column names are not
 * case-sensitive on the platforms this runs on, and the order columns are
 * declared in changes the index but not which rows collide, which is the only
 * question that matters for ON DUPLICATE KEY UPDATE.
 */
function sameKey(requested, actual) {
  const norm = (keys) =>
    [...new Set((keys || []).map((k) => String(k).trim().toLowerCase()))].sort();
  const a = norm(requested);
  const b = norm(actual);
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

class GofrugalSynkerUsecase {
  constructor(gofrugalSynkerRepo) {
    this.gofrugalSynkerRepo = gofrugalSynkerRepo;
  }

  /**
   * Sync a table: create if not exists, then upsert table_items.
   * @param {string} table_name
   * @param {Array<{name: string, type?: string, primaryKey?: boolean, autoIncrement?: boolean, nullable?: boolean}>} table_config
   * @param {string[]} unique_keys - Column names for primary key (required for upsert)
   * @param {Array<Object>} table_items - Rows to insert/update
   */
  async syncTable(table_name, table_config, unique_keys, table_items) {
    try {
      await this.gofrugalSynkerRepo.ensureTable(table_name, table_config, unique_keys);

      // WHAT THE UPSERT WILL ACTUALLY MATCH ON.
      //
      // ensureTable is a CREATE TABLE IF NOT EXISTS, so `unique_keys` only
      // ever built the key of a table that did not exist yet. For a table
      // created earlier - which is every production sync table - a request
      // asking for a different key changes nothing at all, and the upsert
      // below goes on matching rows by the OLD one. Until this check existed
      // that was completely silent: the response said "Synced", the row count
      // was right, and every edited source row whose old key no longer
      // matched was quietly INSERTED as a second copy instead of updating the
      // first. A reader taking one row per reference then keeps showing the
      // stale copy, which is what "edits are not reflecting" looks like from
      // the outside.
      //
      // The sync still runs: refusing it would stop new rows arriving too,
      // and the data is not the problem. It is reported instead - in the
      // response, in the log, and (via utils/api_sync_log_helpers) in the
      // api_sync_log metadata every one of these requests already writes.
      const warnings = await this.inspectKey(table_name, unique_keys);

      const columns = table_config.map((c) => c.name);
      if (table_items && table_items.length > 0) {
        await this.gofrugalSynkerRepo.upsertBatch(
          table_name,
          columns,
          table_items,
          unique_keys
        );
      }

      const result = {
        code: 200,
        msg: "Synced",
        table: table_name,
        rows: table_items?.length || 0
      };
      if (warnings.length) result.warnings = warnings;
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GOFRUGAL_SYNKER",
        code: "USECASE.GOFRUGAL_SYNKER.SYNC",
        description: err.toString(),
        category: "",
        ref: { table_name }
      });
      throw err;
    }
  }

  /**
   * Compares the key the sender asked for against the key the table has, and
   * counts how many source rows the table is already holding more than once.
   *
   * Diagnostic only - it reads, it never alters the table. Changing a
   * production sync table's primary key drops and rebuilds it, and that is
   * not a decision a sync request gets to make on its own.
   *
   * Its own failures are swallowed to a warning: a sync that is otherwise
   * working must not start failing because SHOW KEYS was refused.
   */
  async inspectKey(table_name, unique_keys) {
    const warnings = [];
    try {
      const actualKey = await this.gofrugalSynkerRepo.getPrimaryKeyColumns(
        table_name
      );

      if (!actualKey.length) {
        warnings.push(
          `${table_name} has NO PRIMARY KEY: ON DUPLICATE KEY UPDATE can never match, so every sync inserts another copy of each source row`
        );
      } else if (!sameKey(unique_keys, actualKey)) {
        warnings.push(
          `${table_name} key mismatch: request asked for (${unique_keys.join(
            ", "
          )}) but the table is keyed on (${actualKey.join(
            ", "
          )}); rows are being matched on the table's key, so edits to an existing row may be inserted as duplicates instead of updating it`
        );
      }

      const counts = await this.gofrugalSynkerRepo.countRowsByKeys(
        table_name,
        unique_keys
      );
      if (counts.total_rows > counts.distinct_keys) {
        warnings.push(
          `${table_name} holds ${counts.total_rows} rows for ${
            counts.distinct_keys
          } distinct (${unique_keys.join(", ")}) values: ${
            counts.total_rows - counts.distinct_keys
          } duplicate source rows are already stored`
        );
      }

      if (warnings.length) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.GOFRUGAL_SYNKER",
          code: "USECASE.GOFRUGAL_SYNKER.KEY_MISMATCH",
          description: warnings.join(" | "),
          category: "",
          ref: { table_name, unique_keys, actual_key: actualKey }
        });
      }
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "USECASE.GOFRUGAL_SYNKER",
        code: "USECASE.GOFRUGAL_SYNKER.KEY_INSPECT_FAILED",
        description: err.toString(),
        category: "",
        ref: { table_name }
      });
    }
    return warnings;
  }

  /**
   * Delete (drop) a table by name.
   * @param {string} table_name
   */
  async deleteTable(table_name) {
    try {
      const result = await this.gofrugalSynkerRepo.deleteTable(table_name);
      return { code: 200, msg: "Table deleted", table: table_name, ...result };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GOFRUGAL_SYNKER",
        code: "USECASE.GOFRUGAL_SYNKER.DELETE_TABLE",
        description: err.toString(),
        category: "",
        ref: { table_name }
      });
      throw err;
    }
  }
}

module.exports = (gofrugalSynkerRepo) => {
  return new GofrugalSynkerUsecase(gofrugalSynkerRepo);
};
