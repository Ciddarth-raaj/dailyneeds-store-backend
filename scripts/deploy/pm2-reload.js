#!/usr/bin/env node
/**
 * Reload every long-running process that runs the code this deploy just
 * pulled, and prove each one came back.
 *
 * WHY THIS EXISTS. The deploy used to run `pm2 reload 0` and nothing else,
 * so the API picked up new code and the Biomax receiver did not. The
 * receiver kept running whatever it had been started with until somebody
 * SSHed in and reloaded it by hand - which meant a punch-dating fix could
 * be "deployed" and still not be in effect for live punches. Reloading
 * running processes is the deployment's job; a human should not have to
 * remember it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: START ANYTHING.
 *
 * The receiver is kept out of `ecosystem.config.js` on purpose so that no
 * generic pm2 command can bring it up as a side effect - it opens a TCP
 * listener on 7005 and activating it is a separate, approved production
 * action (see `ecosystem.biomax.config.js`). This reloads it ONLY if it is
 * already running. A process that is not running is reported and skipped,
 * never started. That keeps the original safety property intact while
 * removing the manual step.
 *
 * EXIT CODES: 0 all good; 1 something that had to reload did not.
 *
 * The API is REQUIRED: if it is missing or does not come back online the
 * deploy fails loudly rather than leaving a half-deployed server. Optional
 * targets fail the deploy only if they are running and then fail to reload
 * or to come back online.
 */

const { execFileSync } = require("child_process");

/**
 * Every pm2 process that runs this repository's code.
 *
 * The API is addressed as `0` because that is how it was started and it has
 * no name - changing that is a separate, riskier act than this one.
 *
 * The node-cron schedules (`services/cron_service.js`, `services/synker.js`,
 * `utils/api_sync_log_helpers.js`) all run INSIDE server.js, so reloading
 * the API picks them up too; there is no separate worker to reload.
 */
const TARGETS = [
  {
    id: "0",
    label: "API (server.js, and the node-cron schedules inside it)",
    required: true,
  },
  {
    id: "biomax-receiver",
    label: "Biomax BM70W receiver (biomax/receiver.js)",
    required: false,
    skipNote:
      "not running - a deploy never starts it; activation is a separate approved action (ecosystem.biomax.config.js)",
  },
];

function pm2(args) {
  return execFileSync("pm2", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Every pm2 process, as `{name, pm_id, status}`.
 *
 * `pm2 jlist` is the machine-readable listing, but some pm2 builds print a
 * banner before it, so the JSON is taken from the first `[` rather than by
 * parsing the whole of stdout.
 */
function processList() {
  let raw;
  try {
    raw = pm2(["jlist"]);
  } catch (err) {
    return null; // pm2 itself is unreachable; the caller decides what that means
  }
  const start = raw.indexOf("[");
  if (start < 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch (err) {
    return null;
  }
  return parsed.map((p) => ({
    name: String(p.name),
    pm_id: String(p.pm_id),
    status: p.pm2_env && p.pm2_env.status ? String(p.pm2_env.status) : "unknown",
  }));
}

/** The entry for a target, matched by name or by pm2 id. Null when absent. */
function find(list, id) {
  if (!list) return null;
  return list.find((p) => p.name === id || p.pm_id === id) || null;
}

function main() {
  const before = processList();
  if (before === null) {
    console.error("FAIL  pm2 is not reachable, or `pm2 jlist` returned nothing parseable.");
    process.exit(1);
  }

  const failures = [];

  for (const target of TARGETS) {
    const existing = find(before, target.id);

    if (!existing) {
      if (target.required) {
        failures.push(`${target.label}: REQUIRED but not running under pm2`);
        console.error(`FAIL  ${target.label} - required, but pm2 has no such process`);
      } else {
        console.log(`SKIP  ${target.label} - ${target.skipNote || "not running"}`);
      }
      continue;
    }

    try {
      // Plain reload, exactly as the deploy has always done it. NOT
      // `--update-env`: that re-reads the environment of whatever shell is
      // running the deploy, which is not the one the app was originally
      // started with, and a variable present then but absent now would
      // silently disappear from the running process. `.env` is read from
      // disk by the new process either way, so the key the workflow syncs
      // still takes effect.
      pm2(["reload", target.id]);
    } catch (err) {
      failures.push(`${target.label}: reload command failed`);
      console.error(`FAIL  ${target.label} - reload failed: ${err && err.message}`);
      continue;
    }

    // Reloaded is not the same as running. Ask pm2 again rather than
    // trusting the command's exit code: a process that crashes on the new
    // code exits AFTER the reload returns, and that must fail the deploy.
    const after = find(processList(), target.id);
    if (!after || after.status !== "online") {
      const status = after ? after.status : "gone";
      failures.push(`${target.label}: ${status} after reload`);
      console.error(`FAIL  ${target.label} - status is '${status}' after reload, expected 'online'`);
      continue;
    }

    console.log(`OK    ${target.label} - reloaded and online`);
  }

  if (failures.length) {
    console.error(`\nDeploy failed: ${failures.length} process(es) did not come back.`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log("\nAll long-running backend processes are running the deployed code.");
}

if (require.main === module) main();

module.exports = { TARGETS, find };
