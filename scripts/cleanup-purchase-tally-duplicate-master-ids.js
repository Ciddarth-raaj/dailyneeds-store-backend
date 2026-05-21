#!/usr/bin/env node
/**
 * Removes duplicate rows in purchase_tally_response that share the same MasterID.
 * Keeps the row with the latest created_at (then updated_at, then lexicographically
 * smallest VoucherNo as a stable tie-breaker).
 *
 * Run BEFORE migration 20260521120000-purchase-tally-response-purchase-id when
 * duplicate MasterIDs exist.
 *
 * Usage:
 *   NODE_ENV=development node scripts/cleanup-purchase-tally-duplicate-master-ids.js
 *   NODE_ENV=development node scripts/cleanup-purchase-tally-duplicate-master-ids.js --dry-run
 */

global.env =
  process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;

const mysql = require("mysql");
const config = require("../config.json");

const dryRun = process.argv.includes("--dry-run");

const dbConfig = config.db.mysql[global.env];

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

const COUNT_DUPLICATES_SQL = `
  SELECT COUNT(*) AS duplicate_rows
  FROM purchase_tally_response t1
  INNER JOIN purchase_tally_response t2
    ON t1.MasterID = t2.MasterID
    AND (
      t1.created_at < t2.created_at
      OR (
        t1.created_at = t2.created_at
        AND COALESCE(t1.updated_at, t1.created_at) < COALESCE(t2.updated_at, t2.created_at)
      )
      OR (
        t1.created_at = t2.created_at
        AND COALESCE(t1.updated_at, t1.created_at) = COALESCE(t2.updated_at, t2.created_at)
        AND t1.VoucherNo > t2.VoucherNo
      )
    )
`;

const DELETE_DUPLICATES_SQL = `
  DELETE t1 FROM purchase_tally_response t1
  INNER JOIN purchase_tally_response t2
    ON t1.MasterID = t2.MasterID
    AND (
      t1.created_at < t2.created_at
      OR (
        t1.created_at = t2.created_at
        AND COALESCE(t1.updated_at, t1.created_at) < COALESCE(t2.updated_at, t2.created_at)
      )
      OR (
        t1.created_at = t2.created_at
        AND COALESCE(t1.updated_at, t1.created_at) = COALESCE(t2.updated_at, t2.created_at)
        AND t1.VoucherNo > t2.VoucherNo
      )
    )
`;

async function main() {
  const [{ duplicate_rows }] = await query(COUNT_DUPLICATES_SQL);
  const count = Number(duplicate_rows) || 0;

  console.log(
    `[${global.env}] Duplicate MasterID rows to remove: ${count}${
      dryRun ? " (dry-run)" : ""
    }`
  );

  if (count === 0) {
    pool.end();
    return;
  }

  if (dryRun) {
    const preview = await query(`
      SELECT t1.MasterID, t1.VoucherNo, t1.CostCentre, t1.created_at
      FROM purchase_tally_response t1
      INNER JOIN purchase_tally_response t2
        ON t1.MasterID = t2.MasterID
        AND (
          t1.created_at < t2.created_at
          OR (
            t1.created_at = t2.created_at
            AND COALESCE(t1.updated_at, t1.created_at) < COALESCE(t2.updated_at, t2.created_at)
          )
          OR (
            t1.created_at = t2.created_at
            AND COALESCE(t1.updated_at, t1.created_at) = COALESCE(t2.updated_at, t2.created_at)
            AND t1.VoucherNo > t2.VoucherNo
          )
        )
      ORDER BY t1.MasterID, t1.created_at
      LIMIT 50
    `);
    console.log("Sample rows that would be deleted:");
    console.table(preview);
    pool.end();
    return;
  }

  const result = await query(DELETE_DUPLICATES_SQL);
  console.log(`Deleted ${result.affectedRows} duplicate row(s).`);
  pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end();
  process.exit(1);
});
