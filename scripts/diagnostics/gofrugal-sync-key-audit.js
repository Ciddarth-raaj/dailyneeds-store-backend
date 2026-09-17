#!/usr/bin/env node
/**
 * READ-ONLY audit of the GRN sync tables' keys and duplicates.
 *
 *   NODE_ENV=production node scripts/diagnostics/gofrugal-sync-key-audit.js
 *
 * WHY THIS EXISTS. The receiver (`POST /gofrugal-synker/sync`) creates a
 * table with `CREATE TABLE IF NOT EXISTS ... PRIMARY KEY (unique_keys)`. The
 * key is therefore fixed by whatever the FIRST request that ever created the
 * table asked for, and every later request's `unique_keys` is accepted,
 * validated against `table_config`, and then silently ignored. The upsert
 * goes on matching rows by the table's own key.
 *
 * When that key no longer identifies one source row, `ON DUPLICATE KEY
 * UPDATE` stops finding the existing row and INSERTS a second one. New GRNs
 * keep appearing (an insert is an insert), while an edit to an existing GRN
 * lands in a duplicate row that nothing reads - which is exactly what "edits
 * are not reflecting on /grn" looks like from the outside.
 *
 * This script does not decide anything. It prints the four facts needed to
 * tell that case apart from a sender that simply never resends edited rows:
 *
 *   1. the key each table actually has (SHOW CREATE TABLE)
 *   2. the key the reader assumes (see below)
 *   3. how many rows exist per distinct source key - duplicates mean the
 *      upsert has been inserting instead of updating
 *   4. for a given reference number, every header/detail row stored for it
 *
 * It only SELECTs and SHOWs. It never alters, drops or writes anything:
 * changing a production sync table's primary key rebuilds the table, and
 * that needs its own approval.
 *
 * Optional: pass a GRN reference number to dump its stored rows.
 *
 *   NODE_ENV=production node scripts/diagnostics/gofrugal-sync-key-audit.js GRN-12345
 */

global.env =
  process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;

const mysql = require("mysql");
const config = require("../../config.json");

const HDR = "medishopdb_MED_MRC_HDR";
const DTL = "medishopdb_MED_MRC_DTL";

/**
 * The key that makes one source row, as the READER assumes it.
 *
 * repository/stock_received.js reads a header by MMH_MRC_REFNO and then its
 * lines by MMD_MRC_NO, ordered by MMD_MRC_SL_NO. So one header is one
 * MMH_MRC_NO, and one line is one (MMD_MRC_NO, MMD_MRC_SL_NO).
 */
const EXPECTED = {
  [HDR]: ["MMH_MRC_NO"],
  [DTL]: ["MMD_MRC_NO", "MMD_MRC_SL_NO"],
};

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

async function primaryKeyOf(table) {
  const rows = await query(`SHOW KEYS FROM \`${table}\` WHERE Key_name = 'PRIMARY'`);
  return rows
    .slice()
    .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
    .map((r) => r.Column_name);
}

async function auditTable(table) {
  console.log(`\n=== ${table} ===`);

  const created = await query(`SHOW CREATE TABLE \`${table}\``);
  const ddl = created[0]?.["Create Table"] ?? created[0]?.["Create View"] ?? "";
  console.log(ddl);

  const actual = await primaryKeyOf(table);
  const expected = EXPECTED[table];
  console.log(`\nPRIMARY KEY on the table : (${actual.join(", ") || "NONE"})`);
  console.log(`Reader assumes one row per: (${expected.join(", ")})`);

  const norm = (k) => [...k].map((c) => c.toLowerCase()).sort().join(",");
  if (!actual.length) {
    console.log(
      "VERDICT: NO PRIMARY KEY. ON DUPLICATE KEY UPDATE can never match, so " +
        "every sync inserts another copy of each source row."
    );
  } else if (norm(actual) !== norm(expected)) {
    console.log(
      "VERDICT: KEY MISMATCH. The upsert matches on the table's key, not the " +
        "reader's, so an edited source row can be inserted as a duplicate " +
        "instead of updating the row the reader shows."
    );
  } else {
    console.log("VERDICT: key matches what the reader assumes.");
  }

  const cols = expected.map((c) => `\`${c}\``).join(", ");
  const counts = await query(
    `SELECT COUNT(*) AS total_rows, COUNT(DISTINCT ${cols}) AS distinct_keys FROM \`${table}\``
  );
  const total = Number(counts[0]?.total_rows ?? 0);
  const distinct = Number(counts[0]?.distinct_keys ?? 0);
  console.log(`\nrows: ${total}   distinct (${expected.join(", ")}): ${distinct}`);
  if (total > distinct) {
    console.log(
      `DUPLICATES: ${total - distinct} extra rows. The upsert has been ` +
        "inserting copies rather than updating - this is the fingerprint of " +
        "a wrong/obsolete key, not of a sender that skips edits."
    );
    const worst = await query(
      `SELECT ${cols}, COUNT(*) AS copies
       FROM \`${table}\`
       GROUP BY ${cols}
       HAVING copies > 1
       ORDER BY copies DESC
       LIMIT 10`
    );
    console.log("worst offenders:", JSON.stringify(worst, null, 2));
  } else {
    console.log(
      "NO DUPLICATES under that key. If edits are still missing, the rows " +
        "never arrived - look at the sender's change detection, not here."
    );
  }
}

async function dumpRefno(refno) {
  console.log(`\n=== stored rows for MMH_MRC_REFNO = ${refno} ===`);
  const headers = await query(
    `SELECT * FROM \`${HDR}\` WHERE MMH_MRC_REFNO = ?`,
    [refno]
  );
  console.log(`${headers.length} header row(s):`);
  console.log(JSON.stringify(headers, null, 2));
  if (headers.length > 1) {
    console.log(
      "MORE THAN ONE HEADER for this reference: /grn/detail takes one of " +
        "them, so an edit living in the other one is invisible."
    );
  }

  for (const header of headers) {
    const mrcNo = header.MMH_MRC_NO ?? header.mmh_mrc_no;
    const lines = await query(
      `SELECT MMD_MRC_NO, MMD_MRC_SL_NO, COUNT(*) AS copies
       FROM \`${DTL}\` WHERE MMD_MRC_NO = ?
       GROUP BY MMD_MRC_NO, MMD_MRC_SL_NO
       HAVING copies > 1`,
      [mrcNo]
    );
    console.log(
      `MMD_MRC_NO ${mrcNo}: ${lines.length} duplicated line number(s)` +
        (lines.length ? ` -> ${JSON.stringify(lines)}` : "")
    );
  }
}

async function main() {
  console.log(`[${global.env}] database: ${dbConfig.database}`);
  await auditTable(HDR);
  await auditTable(DTL);

  const refno = process.argv[2];
  if (refno) await dumpRefno(refno);

  console.log(
    "\nNothing was altered. If a key needs changing, that is a separate, " +
      "approved remediation."
  );
  pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end();
  process.exit(1);
});
