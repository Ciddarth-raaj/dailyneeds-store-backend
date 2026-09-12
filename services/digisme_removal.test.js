/**
 * Stage 0C — the Digisme employee sync is REMOVED, not merely paused.
 *
 *   node --test services/digisme_removal.test.js
 *
 * This replaces services/digisme_pause.p1.test.js. That file protected the
 * word "zero": a pause that skipped only the cron would still have let
 * POST /employee/sync run the whole routine, and a pause that returned late
 * would have authenticated against Digisme and upserted designations,
 * departments and outlets before giving up. So it asserted not "it returned
 * 423" but "nothing was called".
 *
 * There is now nothing to call, and that is what this file pins instead. The
 * assertions are deliberately about the SOURCE as well as the behaviour: a
 * future change that reinstated the route, the cron, the credentials or the
 * vendor endpoint - by hand or by reverting a commit - fails here.
 *
 * dnds.co.in is the employee master (Stage 0C / C2). That guard survives the
 * removal and is asserted below, because the rule it enforces is not about
 * Digisme: no legacy or future importer may write the employee master.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/** Statements only; a comment naming Digisme is history, not code. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const GONE = [
  "syncDigismeEmployees",
  "_fetchDigismeEmployees",
  "_authenticateDigisme",
  "getDigismeToken",
  "DIGISME_API_KEY",
  "DIGISME_CUSTOM_KEY",
  "DIGISME_EMPLOYEE_SYNC",
  "indhrmsgateway",
];

/** Every shipped .js file, tests and node_modules excluded. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "docs", "migrations", "scripts", "test_support"].includes(entry.name)) continue;
        walk(rel);
      } else if (entry.name.endsWith(".js") && !entry.name.includes(".test.")) {
        out.push(rel);
      }
    }
  };
  for (const dir of ["services", "routes", "usecase", "repository", "config", "utils", "constants", "biomax", "middlewares"]) {
    walk(dir);
  }
  out.push("server.js");
  return out;
}

describe("no Digisme employee-sync code is left anywhere", () => {
  it("no shipped file references the sync, its credentials or its endpoint", () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      const code = codeOf(read(f));
      for (const gone of GONE) {
        if (code.includes(gone)) offenders.push(`${f}: ${gone}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("no shipped file presents a Digisme credential", () => {
    // The two keys were hard-coded literals in services/synker.js, so they
    // are in git history and must be revoked at the vendor - see
    // docs/digisme-employee-sync-removal.md. The literals are deliberately
    // NOT reproduced here: writing a live credential into a test to assert
    // its absence republishes it. What this checks instead is the shape -
    // the `<uuid>:<secret>` bearer the Authenticate header carried, and the
    // base64 custom key - anywhere near a mention of the vendor.
    const BEARER = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9+/]{20,}/;
    const LONG_B64 = /["'][A-Za-z0-9+/]{60,}={0,2}["']/;
    // Statements only. A comment naming the vendor is history; a commented-out
    // credential is a separate problem from this removal and is reported in
    // docs/digisme-employee-sync-removal.md rather than failed here.
    for (const f of sourceFiles()) {
      const code = codeOf(read(f));
      assert.ok(!BEARER.test(code), `${f} carries something shaped like the Digisme bearer credential`);
      if (/digisme/i.test(code)) {
        assert.ok(!LONG_B64.test(code), `${f} mentions Digisme and carries a long opaque literal`);
      }
    }
  });

  it("the vendor cipher the sync used is no longer required by anything shipped", () => {
    const users = sourceFiles().filter((f) => f !== path.join("utils", "encryptAES.js"))
      .filter((f) => /require\(["'][^"']*encryptAES["']\)/.test(codeOf(read(f))));
    assert.deepEqual(users, [], "utils/encryptAES.js has a committed key and a fixed IV; nothing should use it");
  });
});

describe("the route is gone", () => {
  it("routes/employee.js registers no /sync endpoint", () => {
    const code = codeOf(read("routes/employee.js"));
    assert.ok(!/router\.post\(\s*["']\/sync["']/.test(code));
  });

  it("usecase/employee.js has neither sync() nor the synker handle", () => {
    const code = codeOf(read("usecase/employee.js"));
    assert.ok(!/\bsync\(\)\s*\{/.test(code));
    assert.ok(!/setSynker/.test(code));
    assert.ok(!/this\.synker/.test(code));
  });

  it("server.js no longer wires the synker into the employee usecase", () => {
    const code = codeOf(read("server.js"));
    assert.ok(!/employeeUsecase\.setSynker/.test(code));
  });
});

describe("the cron is gone", () => {
  it("no employee_sync job is registered, and nothing is registered behind a flag", () => {
    const code = codeOf(read("services/synker.js"));
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    const registered = [...init.matchAll(/register\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
    assert.ok(!registered.includes("employee_sync"));
    assert.deepEqual(registered.sort(), ["product_sync", "stock_holding_report_sync"]);
  });

  it("no cron expression for it survives", () => {
    const code = codeOf(read("services/synker.js"));
    assert.ok(!/CRON_SYNTAX_EMPLOYEE/.test(code));
  });
});

describe("what the removal deliberately KEEPS", () => {
  it("the C2 local-master guard, because the rule is not about Digisme", () => {
    delete require.cache[require.resolve("../config/lifecycle")];
    delete process.env.LOCAL_EMPLOYEE_MASTER;
    const lifecycle = require("../config/lifecycle");
    assert.equal(lifecycle.localEmployeeMaster, true, "defaults ON: a lost .env fails towards local HR writes winning");
    assert.match(lifecycle.LOCAL_MASTER_MESSAGE, /employee master/);
  });

  it("and it no longer exposes a Digisme pause flag at all", () => {
    delete require.cache[require.resolve("../config/lifecycle")];
    const lifecycle = require("../config/lifecycle");
    assert.equal(lifecycle.digisme, undefined);
    assert.equal(lifecycle.PAUSED_MESSAGE, undefined);
  });

  it("the api_sync_types entry, so historical employee_sync log rows still render", () => {
    const types = require("../constants/api_sync_types");
    const entry = (types.API_SYNC_TYPES || types).find((t) => t.type === "employee_sync");
    assert.ok(entry, "the log type is kept on purpose - see the comment beside it");
  });

  it("the attendance import, which is a different DigiSME integration entirely", () => {
    // A spreadsheet of punches uploaded by hand. It shares a vendor name and
    // nothing else: no credentials, no network call, no employee-master write.
    const code = codeOf(read("usecase/attendance_import.js"));
    assert.match(code, /DIGISME_IMPORT/);
    for (const gone of GONE) assert.ok(!code.includes(gone), `the import must not reference ${gone}`);
  });
});
