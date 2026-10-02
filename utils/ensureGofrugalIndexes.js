const logger = require("./logger");

const INDEX_NAME = "idx_med_mrc_dtl_item_code_mrc_no";
const TABLE_NAME = "medishopdb_MED_MRC_DTL";

/**
 * Every index this app relies on in the GoFrugal sync database.
 *
 * `leadingColumn` lets an index the table ALREADY has count: if any index
 * starts with that column the lookups are covered, whatever it is called, so
 * nothing is added on top of it.
 */
const INDEXES = [
  // Purchase Ref's listLatestGrnPricingByProduct: `MMD_ITEM_CODE IN (...)`.
  {
    table: TABLE_NAME,
    name: INDEX_NAME,
    columns: "MMD_ITEM_CODE, MMD_MRC_NO",
  },
  // GRN No lookups: /grn/detail (`MMH_MRC_REFNO = ?`) and /grn/search
  // (`MMH_MRC_REFNO LIKE 'term%'`), so a search stays a range scan however
  // many years of GRNs the header table holds.
  {
    table: "medishopdb_MED_MRC_HDR",
    name: "idx_med_mrc_hdr_mrc_refno",
    columns: "MMH_MRC_REFNO",
    leadingColumn: "MMH_MRC_REFNO",
  },
];

function query(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function indexExists(connection, index) {
  const rows = index.leadingColumn
    ? await query(
        connection,
        `SELECT COUNT(*) AS cnt
         FROM information_schema.statistics
         WHERE table_schema = DATABASE()
           AND table_name = ?
           AND (index_name = ? OR (column_name = ? AND seq_in_index = 1))`,
        [index.table, index.name, index.leadingColumn]
      )
    : await query(
        connection,
        `SELECT COUNT(*) AS cnt
         FROM information_schema.statistics
         WHERE table_schema = DATABASE()
           AND table_name = ?
           AND index_name = ?`,
        [index.table, index.name]
      );
  return Number(rows[0]?.cnt) > 0;
}

async function ensureIndex(connection, index) {
  try {
    if (await indexExists(connection, index)) return;

    logger.Log({
      level: logger.LEVEL.INFO,
      component: "UTIL.ENSURE_GOFRUGAL_INDEXES",
      code: "UTIL.ENSURE_GOFRUGAL_INDEXES.CREATING",
      description: `Adding missing index ${index.name} on ${index.table}`,
      category: "",
      ref: {},
    });

    const start = Date.now();
    await query(
      connection,
      `ALTER TABLE \`${index.table}\`
       ADD INDEX \`${index.name}\` (${index.columns})`
    );

    logger.Log({
      level: logger.LEVEL.INFO,
      component: "UTIL.ENSURE_GOFRUGAL_INDEXES",
      code: "UTIL.ENSURE_GOFRUGAL_INDEXES.CREATED",
      description: `Added ${index.name} in ${((Date.now() - start) / 1000).toFixed(1)}s`,
      category: "",
      ref: {},
    });
  } catch (err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "UTIL.ENSURE_GOFRUGAL_INDEXES",
      code: "UTIL.ENSURE_GOFRUGAL_INDEXES.ERROR",
      description: `${index.name}: ${err.toString()}`,
      category: "",
      ref: {},
    });
  }
}

/**
 * Idempotently ensures the GoFrugal sync connection has the indexes in
 * INDEXES above. Purchase Ref's listLatestGrnPricingByProduct
 * (repository/stock_received.js) relies on the MED_MRC_DTL one to keep its
 * chunked lookups from full-scanning the GRN detail history table; GRN No
 * search and detail rely on the MED_MRC_HDR one.
 *
 * These tables aren't managed by db-migrate (that only targets the main app
 * DB), so they're applied here on boot instead of via a migration. Safe to run
 * on every startup: skips an index that is already present, and a failure
 * (e.g. insufficient privileges) is logged rather than crashing the server -
 * each index on its own, so one failing does not stop the other.
 */
async function ensureGofrugalIndexes(gofrugalConnection) {
  if (!gofrugalConnection) return;
  for (const index of INDEXES) {
    await ensureIndex(gofrugalConnection, index);
  }
}

module.exports = { ensureGofrugalIndexes, INDEX_NAME, TABLE_NAME, INDEXES };
