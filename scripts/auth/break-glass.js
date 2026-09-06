#!/usr/bin/env node
/**
 * Break-glass (system) account lifecycle — Stage 0A (A4, A5).
 *
 * This is the ONLY way a system account is created, rotated, disabled or
 * re-enabled. No HTTP route can do any of it: every mutating statement in
 * repository/user.js carries `AND is_system_account = 0`, and no route sets
 * the flag. That separation is the point — an attacker holding an admin
 * session cannot mint or capture the emergency credential.
 *
 * Usage (run on the server, from the repository root, with DB access):
 *
 *   BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js create  --username <name>
 *   BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js rotate  --username <name>
 *   BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js disable --username <name>
 *   BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js enable  --username <name>
 *                           node scripts/auth/break-glass.js list
 *
 * The password is typed at a hidden prompt, twice. It is never an argument,
 * never an environment variable, never printed, never logged. The script
 * hashes it with the same scrypt service the app uses and stores only the
 * hash. If you need a generated value, generate it in your password manager
 * and paste it at the prompt.
 *
 * Every action writes a row to user_auth_log with actor_user_id NULL and
 * detail 'break-glass-script', so the audit shows it came from here.
 */

const path = require("path");
const readline = require("readline");

process.env.NODE_ENV = process.env.NODE_ENV || "production";
// Mirror server.js exactly: NODE_ENV unset selects "development" — which, on
// the production host, is the live database block (NODE_ENV is not set
// there). Without this default the script crashed with
// `config.db.mysql[undefined]` on the very host it is meant for.
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
global.isDev = () => global.env === "development";

const mysql = require("mysql");
const passwordService = require(path.join(__dirname, "../../services/password"));
const policy = require(path.join(__dirname, "../../utils/password_policy"));
const authConfig = require(path.join(__dirname, "../../config/auth"));

const args = process.argv.slice(2);
const command = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

const connect = () => {
  let config;
  try {
    config = require(path.join(__dirname, "../../config.json"));
  } catch (err) {
    die("config.json not found. Run this from the repository root on the server.");
  }
  const c = config.db.mysql[global.env];
  return mysql.createConnection({
    host: c.host,
    user: c.username,
    password: c.password,
    database: c.database,
    port: c.port,
  });
};

const query = (db, sql, params) =>
  new Promise((resolve, reject) => db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

/** Read a line with echo off. Falls back to visible input on a non-TTY with a warning. */
const promptHidden = (label) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdoutWrite = rl._writeToOutput;
    process.stdout.write(label);
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl._writeToOutput = stdoutWrite;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });

const readPasswordTwice = async () => {
  if (!process.stdin.isTTY) die("Refusing to read a break-glass password from a non-interactive stdin.");
  const a = await promptHidden("New break-glass password (hidden): ");
  const b = await promptHidden("Repeat it (hidden): ");
  if (a !== b) die("The two entries do not match.");
  const verdict = policy.check(a, { minLength: authConfig.password.policy.breakGlassMinLength });
  if (!verdict.ok) die(`Rejected: ${verdict.reason}`);
  return a;
};

const audit = (db, event, userId, username) =>
  query(
    db,
    "INSERT INTO `user_auth_log` (`user_id`, `username_attempted`, `event`, `detail`) VALUES (?, ?, ?, 'break-glass-script')",
    [userId, username, event]
  );

const requireConfirm = () => {
  if (process.env.BREAK_GLASS_CONFIRM !== "yes") {
    die("Set BREAK_GLASS_CONFIRM=yes to run a mutating command. This is deliberate friction.");
  }
};

async function main() {
  const db = connect();
  try {
    if (command === "list") {
      const rows = await query(
        db,
        "SELECT user_id, username, status, credential_rotated_at, last_login_at, ip_policy FROM `user` WHERE is_system_account = 1"
      );
      if (rows.length === 0) console.log("No system accounts.");
      for (const r of rows) {
        console.log(
          `user_id=${r.user_id} username=${r.username} status=${r.status} rotated=${r.credential_rotated_at || "never"} last_login=${r.last_login_at || "never"} ip_policy=${r.ip_policy}`
        );
      }
      return;
    }

    const username = opt("username");
    if (!username) die("--username is required");
    requireConfirm();

    if (command === "create") {
      const existing = await query(db, "SELECT user_id FROM `user` WHERE username = ?", [username]);
      if (existing.length) die(`A user named ${username} already exists. Choose a distinct name.`);
      const password = await readPasswordTwice();
      const hash = await passwordService.hash(password);
      const res = await query(
        db,
        `INSERT INTO \`user\`
           (username, user_type, employee_id, password, password_hash, password_algo,
            must_change_password, is_system_account, ip_policy, allowed_ips, credential_rotated_at, status)
         VALUES (?, 2, NULL, NULL, ?, 'scrypt', 0, 1, 'unrestricted', NULL, NOW(), 1)`,
        [username, hash]
      );
      await audit(db, "system_account_created", res.insertId, username);
      console.log(`Created system account user_id=${res.insertId} username=${username}.`);
      console.log("Record the credential in the sealed custody envelope now. It is not stored anywhere else.");
      return;
    }

    const rows = await query(db, "SELECT user_id, status FROM `user` WHERE username = ? AND is_system_account = 1", [username]);
    if (rows.length !== 1) die(`No system account named ${username}.`);
    const { user_id } = rows[0];

    if (command === "rotate") {
      const password = await readPasswordTwice();
      const hash = await passwordService.hash(password);
      await query(
        db,
        "UPDATE `user` SET password_hash = ?, password_algo = 'scrypt', password = NULL, credential_rotated_at = NOW(), token_valid_from = NOW(), failed_login_count = 0, locked_until = NULL WHERE user_id = ? AND is_system_account = 1",
        [hash, user_id]
      );
      await audit(db, "break_glass_credential_rotated", user_id, username);
      console.log(`Rotated credential for user_id=${user_id}. Update the sealed custody envelope.`);
      return;
    }

    if (command === "disable" || command === "enable") {
      const status = command === "enable" ? 1 : 0;
      await query(db, "UPDATE `user` SET status = ?, token_valid_from = NOW() WHERE user_id = ? AND is_system_account = 1", [status, user_id]);
      await audit(db, status ? "system_account_created" : "token_revoked", user_id, username);
      console.log(`${command}d user_id=${user_id}.`);
      return;
    }

    die("Unknown command. Use create | rotate | disable | enable | list.");
  } finally {
    db.end();
  }
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
