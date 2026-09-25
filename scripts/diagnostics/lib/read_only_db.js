/**
 * A database handle the diagnostics may use, and that CANNOT write.
 *
 * Two independent locks:
 *   1. every pooled connection runs `SET SESSION TRANSACTION READ ONLY`
 *      before anything else, so the SERVER refuses a write;
 *   2. every statement is inspected before it is sent, and anything that is
 *      not a SELECT is refused here with an error - it never reaches MySQL.
 * `getConnection` (the transactional path every repository write uses) is
 * not offered at all.
 *
 * Credentials come from the backend's own `config.json` - the file
 * `drivers/mysql.js` reads - at `DN_CONFIG` (default: the repository root of
 * this checkout), under `NODE_ENV` (default `production` here, because the
 * only reason to run a diagnostic is to read production).
 */
const path = require("path");
const mysql = require("mysql");

function openReadOnly() {
  const env = process.env.NODE_ENV || "production";
  global.env = env;
  const configPath = process.env.DN_CONFIG || path.join(__dirname, "..", "..", "..", "config.json");
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const config = require(configPath);
  const db = config.db.mysql[env];

  const pool = mysql.createPool({
    connectionLimit: 2,
    host: db.host,
    user: db.username,
    password: db.password,
    database: db.database,
    port: db.port,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  pool.on("connection", (connection) => connection.query("SET SESSION TRANSACTION READ ONLY"));

  const isRead = (sql) => {
    const text = String(sql && typeof sql === "object" ? sql.sql : sql)
      .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, "")
      .trim();
    return /^(SELECT|\(\s*SELECT|WITH)\b/i.test(text) && !/\bFOR\s+UPDATE\b/i.test(text);
  };

  const handle = {
    query(sql, params, cb) {
      const callback = typeof params === "function" ? params : cb;
      const values = typeof params === "function" ? [] : params;
      if (!isRead(sql)) {
        callback(new Error(`READ-ONLY DIAGNOSTIC refused a non-SELECT statement: ${String(sql).trim().slice(0, 80)}`));
        return;
      }
      pool.query(sql, values, callback);
    },
    getConnection() {
      throw new Error("READ-ONLY DIAGNOSTIC: transactions are not available");
    },
  };

  const select = (sql, params = []) =>
    new Promise((resolve, reject) => handle.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  return { db: handle, select, end: () => new Promise((resolve) => pool.end(resolve)), isRead };
}

/** `--name value` from argv, or null. */
function arg(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Print one labelled block. */
function out(label, value) {
  console.log(`\n=== ${label}`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

module.exports = { openReadOnly, arg, out };
