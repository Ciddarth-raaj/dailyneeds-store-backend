#!/usr/bin/env node
/**
 * Stage 0A / gate 5 — write a MySQL client "defaults file" for the
 * backup / restore tooling, so that no credential is ever passed as a
 * command-line argument, echoed to a terminal, or left in shell history.
 *
 * Two profiles:
 *
 *   app    — read from the SAME config.json the running backend uses
 *            (config.db.mysql[<env>]). NOTE: production runs with NODE_ENV
 *            unset, so server.js selects the "development" block, and THAT
 *            block is the live dnds_prod connection on RDS. The label is
 *            misleading; this tool defaults to the same block deliberately
 *            and prints which database it points at so you can confirm.
 *
 *   admin  — for an RDS user that can CREATE DATABASE (the master user or a
 *            dedicated rehearsal role). Host/port/user are given as
 *            arguments; the password is read at a hidden prompt.
 *
 * Output: a file under ~/.stage0a/ with mode 600, in my.cnf format:
 *
 *   [client]
 *   host=...
 *   port=...
 *   user=...
 *   password=...
 *
 * Only host, port, user and (for app) database are printed. The password is
 * never printed. Use the file with:
 *   mysqldump --defaults-extra-file=~/.stage0a/app.cnf ...
 *   mysql     --defaults-extra-file=~/.stage0a/app.cnf ...
 *
 * Usage:
 *   node scripts/auth/db-defaults-file.js app   [--env development] [--out ~/.stage0a/app.cnf]
 *   node scripts/auth/db-defaults-file.js admin --host H --port P --user U [--out ~/.stage0a/admin.cnf]
 *   node scripts/auth/db-defaults-file.js show  [--env development]     # prints host/port/user/database only
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

// Mirror server.js exactly: NODE_ENV unset => "development" (which, in this
// deployment, is the live database).
const defaultEnv = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;

const loadAppBlock = (env) => {
  const configPath = opt("config", path.join(__dirname, "../../config.json"));
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    die(`Cannot read ${configPath}: ${err.message}. Run from the repository root on the server, or pass --config.`);
  }
  const block = config && config.db && config.db.mysql && config.db.mysql[env];
  if (!block) die(`config.db.mysql["${env}"] not found in ${configPath}`);
  for (const k of ["host", "port", "username", "password", "database"]) {
    if (block[k] === undefined || block[k] === null || block[k] === "") die(`config.db.mysql["${env}"].${k} is missing`);
  }
  return block;
};

const promptHidden = (label) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const stdoutWrite = rl._writeToOutput;
    rl._writeToOutput = function (s) {
      if (s.includes(label)) stdoutWrite.call(rl, s);
      else stdoutWrite.call(rl, "");
    };
    rl.question(label, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });

/** my.cnf values: quote anything with spaces or '#' so it round-trips. */
const cnfValue = (v) => {
  const s = String(v);
  return /[\s#'"\\]/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
};

const writeDefaults = (outPath, { host, port, user, password }) => {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const body = ["[client]", `host=${cnfValue(host)}`, `port=${cnfValue(port)}`, `user=${cnfValue(user)}`, `password=${cnfValue(password)}`, ""].join("\n");
  // O_EXCL-free but mode-first: write to a private temp name then rename, so
  // the file never exists world-readable even for an instant.
  const tmp = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, outPath);
};

const home = os.homedir();

(async () => {
  if (command === "show" || command === "app") {
    const env = opt("env", defaultEnv);
    const b = loadAppBlock(env);
    const note = env === "development" ? " (NOTE: this block is the LIVE database in this deployment — NODE_ENV is unset on the server)" : "";
    process.stdout.write(`env=${env}${note}\nhost=${b.host}\nport=${b.port}\nuser=${b.username}\ndatabase=${b.database}\n`);
    if (command === "show") return;
    const out = opt("out", path.join(home, ".stage0a", "app.cnf"));
    writeDefaults(out, { host: b.host, port: b.port, user: b.username, password: b.password });
    process.stdout.write(`defaults file written: ${out} (mode 600; password not shown)\n`);
    return;
  }

  if (command === "admin") {
    const host = opt("host");
    const port = opt("port", "3306");
    const user = opt("user");
    if (!host || !user) die("admin requires --host and --user (and optionally --port)");
    let password;
    if (args.includes("--password-from-stdin")) {
      // non-interactive use (piped from a secret store); still never an argument
      password = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
    } else {
      if (!process.stdin.isTTY) die("admin needs an interactive terminal to read the password without echo (or --password-from-stdin)");
      password = await promptHidden(`Password for ${user}@${host} (hidden): `);
    }
    if (!password) die("empty password");
    const out = opt("out", path.join(home, ".stage0a", "admin.cnf"));
    writeDefaults(out, { host, port, user, password });
    process.stdout.write(`host=${host}\nport=${port}\nuser=${user}\ndefaults file written: ${out} (mode 600; password not shown)\n`);
    return;
  }

  die("usage: db-defaults-file.js app|admin|show [options]  (see header comment)");
})();
