const logger = require("./logger");

const INDEX_NAME = "idx_med_mrc_dtl_item_code_mrc_no";
const TABLE_NAME = "medishopdb_MED_MRC_DTL";

function query(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Idempotently ensures medishopdb_MED_MRC_DTL(MMD_ITEM_CODE, MMD_MRC_NO)
 * exists on the GoFrugal sync connection. Purchase Ref's
 * listLatestGrnPricingByProduct (repository/stock_received.js) relies on
 * this index to keep its chunked lookups from full-scanning the GRN detail
 * history table.
 *
 * This table isn't managed by db-migrate (that only targets the main app
 * DB), so it's applied here on boot instead of via a migration. Safe to run
 * on every startup: skips if the index is already present, and a failure
 * (e.g. insufficient privileges) is logged rather than crashing the server.
 */
async function ensureGofrugalIndexes(gofrugalConnection) {
  if (!gofrugalConnection) return;

  try {
    const existing = await query(
      gofrugalConnection,
      `SELECT COUNT(*) AS cnt
       FROM information_schema.statistics
       WHERE table_schema = DATABASE()
         AND table_name = ?
         AND index_name = ?`,
      [TABLE_NAME, INDEX_NAME]
    );

    if (Number(existing[0]?.cnt) > 0) {
      return;
    }

    logger.Log({
      level: logger.LEVEL.INFO,
      component: "UTIL.ENSURE_GOFRUGAL_INDEXES",
      code: "UTIL.ENSURE_GOFRUGAL_INDEXES.CREATING",
      description: `Adding missing index ${INDEX_NAME} on ${TABLE_NAME}`,
      category: "",
      ref: {},
    });

    const start = Date.now();
    await query(
      gofrugalConnection,
      `ALTER TABLE \`${TABLE_NAME}\`
       ADD INDEX \`${INDEX_NAME}\` (MMD_ITEM_CODE, MMD_MRC_NO)`
    );

    logger.Log({
      level: logger.LEVEL.INFO,
      component: "UTIL.ENSURE_GOFRUGAL_INDEXES",
      code: "UTIL.ENSURE_GOFRUGAL_INDEXES.CREATED",
      description: `Added ${INDEX_NAME} in ${((Date.now() - start) / 1000).toFixed(1)}s`,
      category: "",
      ref: {},
    });
  } catch (err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "UTIL.ENSURE_GOFRUGAL_INDEXES",
      code: "UTIL.ENSURE_GOFRUGAL_INDEXES.ERROR",
      description: err.toString(),
      category: "",
      ref: {},
    });
  }
}

module.exports = { ensureGofrugalIndexes, INDEX_NAME, TABLE_NAME };
