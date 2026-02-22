const logger = require("../utils/logger");

class GofrugalSynkerUsecase {
  constructor(gofrugalSynkerRepo) {
    this.gofrugalSynkerRepo = gofrugalSynkerRepo;
  }

  /**
   * Sync a table: create if not exists, then upsert table_items.
   * @param {string} table_name
   * @param {Array<{name: string, type?: string, primaryKey?: boolean, autoIncrement?: boolean, nullable?: boolean}>} table_config
   * @param {string[]} unique_keys - Column names for unique constraint (required for upsert)
   * @param {Array<Object>} table_items - Rows to insert/update
   */
  async syncTable(table_name, table_config, unique_keys, table_items) {
    try {
      await this.gofrugalSynkerRepo.ensureTable(table_name, table_config, unique_keys);
      const columns = table_config.map((c) => c.name);
      if (table_items && table_items.length > 0) {
        await this.gofrugalSynkerRepo.upsertBatch(
          table_name,
          columns,
          table_items,
          unique_keys
        );
      }
      return { code: 200, msg: "Synced", table: table_name, rows: table_items?.length || 0 };
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
}

module.exports = (gofrugalSynkerRepo) => {
  return new GofrugalSynkerUsecase(gofrugalSynkerRepo);
};
