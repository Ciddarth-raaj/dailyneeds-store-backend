#!/usr/bin/env node
/**
 * Adds an index on medishopdb_MED_MRC_DTL(MMD_ITEM_CODE, MMD_MRC_NO) in the
 * GoFrugal sync database (dailyneeds_gofrugal_sync).
 *
 * Purchase Ref's "latest GRN pricing per product" lookup
 * (repository/stock_received.js listLatestGrnPricingByProduct) queries this
 * table in chunks of ~200 product ids via `WHERE MMD_ITEM_CODE IN (...)`.
 * Without an index on MMD_ITEM_CODE, each chunk forces a full scan of the
 * whole table (which only grows over time as more GRNs are entered) - with
 * ~14,000+ products in scope that's ~70 chunks, each doing a full scan, which
 * is almost certainly the dominant cost behind Purchase Ref's slow load.
 *
 * This table is NOT managed by db-migrate (that only targets the main app
 * database - see migrations/mysql/sample.database.json), so this index is
 * added via a standalone script against the mysql_gofrugal connection
 * instead of a migration.
 *
 * Idempotent: skips if the index already exists.
 *
 * Usage:
 *   NODE_ENV=production node scripts/add-gofrugal-mrc-dtl-item-code-index.js
 */

global.env =
  process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;

const mysql = require("mysql");
const config = require("../config.json");

const INDEX_NAME = "idx_med_mrc_dtl_item_code_mrc_no";
const TABLE_NAME = "medishopdb_MED_MRC_DTL";

const dbConfig = config.db.mysql_gofrugal[global.env];

const pool = mysql.createPool({
  connectionLimit: 2,
  host: dbConfig.host,
  user: dbConfig.username,
  password: dbConfig.password,
  database: dbConfig.database,
  port: dbConfig.port,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function main() {
  const existing = await query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.statistics
     WHERE table_schema = ?
       AND table_name = ?
       AND index_name = ?`,
    [dbConfig.database, TABLE_NAME, INDEX_NAME]
  );

  if (Number(existing[0]?.cnt) > 0) {
    console.log(
      `[${global.env}] Index ${INDEX_NAME} already exists on ${TABLE_NAME}. Nothing to do.`
    );
    pool.end();
    return;
  }

  console.log(
    `[${global.env}] Adding index ${INDEX_NAME} on ${TABLE_NAME}(MMD_ITEM_CODE, MMD_MRC_NO)...`
  );
  const start = Date.now();
  await query(
    `ALTER TABLE \`${TABLE_NAME}\`
     ADD INDEX \`${INDEX_NAME}\` (MMD_ITEM_CODE, MMD_MRC_NO)`
  );
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
  pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end();
  process.exit(1);
});
