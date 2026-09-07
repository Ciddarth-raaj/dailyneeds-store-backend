#!/usr/bin/env node
/**
 * Stage 0B / B2 — capture and restore the auth columns of specific users.
 *
 * Why this exists: the rehearsal used to build its undo statements in SQL,
 * CONCAT'ing QUOTE(password) with string literals. On the real database that
 * failed with `ERROR 1270 Illegal mix of collations` - the column and the
 * literal do not share one - and the run aborted AFTER the passwords had
 * been changed, leaving the scratch copy dirty.
 *
 * Values now never pass through SQL string building at all. They are read
 * into memory with the project's own mysql driver and written back as bound
 * parameters, so collation, quoting and escaping cannot come into it and the
 * bytes round-trip exactly. Dates are read as strings (`dateStrings`) so the
 * value that goes back is the value that came out.
 *
 * Usage:
 *   b2-user-auth.js capture --db <scratch> --users 1,2,3 --out <file.json>
 *   b2-user-auth.js restore --db <scratch> --in  <file.json>
 *   b2-user-auth.js verify  --db <scratch> --in  <file.json>
 *
 * Options: --config <config.json> (default: the checkout's own), --env <block>.
 *
 * Credentials come from the APPLICATION's own config.json - the same file,
 * the same block (`db.mysql[NODE_ENV || "development"]`) and the same driver
 * the server itself connects with. An earlier version parsed the MySQL
 * defaults file by hand and got `ER_ACCESS_DENIED_ERROR` on the real host,
 * because option-file syntax is not `key=value`: values may be quoted, may
 * contain `#`, and escapes are interpreted. Reusing the config the app is
 * already proven to connect with removes that whole class of bug; a JSON
 * string needs no parsing rules of its own.
 *
 * The DATABASE from that config is deliberately ignored and replaced with
 * the scratch schema given on the command line, which must look like a
 * scratch copy - so pointing this at dnds_prod is impossible even though the
 * credentials it uses are the ones that could reach it.
 *
 * No column value is ever printed: output is column NAMES, row counts and
 * PASS/FAIL only.
 */
const fs = require("fs");
const path = require("path");

/** The columns a login or a staging password can change. */
const AUTH_COLUMNS = [
  "password",
  "password_hash",
  "password_algo",
  "must_change_password",
  "password_flag_reason",
  "failed_login_count",
  "locked_until",
  "last_login_at",
  "token_valid_from",
  "credential_rotated_at",
];

const die = (msg) => {
  process.stderr.write(`FAIL: ${msg}\n`);
  process.exit(1);
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  return undefined;
};

/**
 * The application's own database credentials, from its config.json.
 * `global.env` follows server.js exactly: NODE_ENV unset means "development",
 * which on the production host IS the live block. Values are used, never
 * logged - not even the user name.
 */
function readAppConfig(file, envName) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    die(`cannot read the application config ${file}: ${err.message}`);
  }
  const env = envName || (process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV);
  const block = config && config.db && config.db.mysql && config.db.mysql[env];
  if (!block) die(`${file} has no db.mysql.${env} block`);
  if (!block.username) die(`db.mysql.${env} in ${file} has no username`);
  return {
    host: block.host,
    port: Number(block.port || 3306),
    user: block.username,
    password: block.password === undefined || block.password === null ? "" : String(block.password),
    env: env,
  };
}

function connect(db) {
  const cfg = readAppConfig(arg("config", path.join(__dirname, "../../config.json")), arg("env"));
  const mysql = require(path.join(__dirname, "../../node_modules/mysql"));
  return mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    // The scratch schema from the command line ALWAYS wins over the database
    // named in the config, which is how these production credentials are kept
    // pointed at a copy.
    database: db,
    // Read datetimes as the strings MySQL printed, so the value written back
    // is byte-identical rather than a re-formatted Date.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

const query = (db, sql, params) =>
  new Promise((resolve, reject) => db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

/** Only ever act on a scratch copy - same rule as the rehearsal script. */
function requireScratch(db) {
  if (!/rehearsal|scratch|restore_test/.test(db)) {
    die(`refusing to touch '${db}' - not a scratch schema`);
  }
}

/** The auth columns this table actually has, in ordinal order. */
async function presentColumns(db) {
  const rows = await query(
    db.conn,
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user' AND COLUMN_NAME IN (?)
      ORDER BY ORDINAL_POSITION`,
    [db.name, AUTH_COLUMNS]
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function main() {
  const command = process.argv[2];
  const dbName = arg("db");
  if (!command || !dbName) die("usage: b2-user-auth.js capture|restore|verify --db <scratch> [--users 1,2] [--out|--in file] [--config config.json] [--env block]");
  requireScratch(dbName);

  const conn = connect(dbName);
  const db = { conn, name: dbName };
  await new Promise((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));

  try {
    const cols = await presentColumns(db);
    if (cols.length === 0) die("the user table has none of the auth columns");

    if (command === "capture") {
      const users = String(arg("users", "")).split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      if (users.length === 0) die("--users must be a comma-separated list of user ids");
      const out = arg("out");
      if (!out) die("--out is required");
      const rows = await query(db.conn, `SELECT user_id, ?? FROM \`user\` WHERE user_id IN (?) ORDER BY user_id`, [cols, users]);
      if (rows.length !== users.length) {
        die(`expected ${users.length} users, found ${rows.length} - refusing to capture a partial snapshot`);
      }
      const payload = { database: dbName, columns: cols, users, rows, captured_at: new Date().toISOString() };
      fs.writeFileSync(out, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.chmodSync(out, 0o600);
      console.log(`captured auth columns for ${rows.length} users into ${out} (values not shown)`);
      console.log(`  columns: ${cols.join(", ")}`);
      return;
    }

    const inFile = arg("in");
    if (!inFile) die("--in is required");
    const snap = JSON.parse(fs.readFileSync(inFile, "utf8"));
    if (snap.database !== dbName) die(`snapshot is for '${snap.database}', not '${dbName}'`);
    if (!Array.isArray(snap.rows) || snap.rows.length === 0) die("snapshot has no rows");

    if (command === "restore") {
      for (const row of snap.rows) {
        const setCols = snap.columns.filter((c) => c in row);
        const values = setCols.map((c) => row[c]);
        // Bound parameters: no quoting, no escaping, no collation.
        await query(
          db.conn,
          `UPDATE \`user\` SET ${setCols.map((c) => "?? = ?").join(", ")} WHERE user_id = ?`,
          [...setCols.flatMap((c, i) => [c, values[i]]), row.user_id]
        );
      }
      console.log(`restored auth columns for ${snap.rows.length} users (values not shown)`);
    }

    // verify runs after restore, and standalone
    const ids = snap.rows.map((r) => r.user_id);
    const now = await query(db.conn, `SELECT user_id, ?? FROM \`user\` WHERE user_id IN (?) ORDER BY user_id`, [snap.columns, ids]);
    let bad = 0;
    for (const want of snap.rows) {
      const got = now.find((r) => String(r.user_id) === String(want.user_id));
      if (!got) {
        console.log(`  FAIL  user ${want.user_id} not found`);
        bad++;
        continue;
      }
      const differing = snap.columns.filter((c) => {
        const a = want[c];
        const b = got[c];
        if (a === null || a === undefined) return !(b === null || b === undefined);
        return String(a) !== String(b);
      });
      if (differing.length === 0) {
        console.log(`  PASS  user ${want.user_id}: all ${snap.columns.length} auth columns match the snapshot`);
      } else {
        // names only - never the values
        console.log(`  FAIL  user ${want.user_id}: differing columns: ${differing.join(", ")}`);
        bad++;
      }
    }
    if (bad > 0) die(`${bad} user(s) do not match the snapshot`);
    console.log("AUTH RESTORE VERIFIED");
  } finally {
    conn.end();
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
