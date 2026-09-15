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
/**
 * Statements only; a comment naming Digisme is history, not code.
 *
 * CAUTION, and the reason for the canary test below. This strips block
 * comments FIRST, so a `/*` sequence appearing inside a `//` line comment -
 * writing a glob like `config/` + `*.js`, say - opens a block comment that
 * runs to the next `*` + `/` and SWALLOWS THE CODE BETWEEN THEM. That fails
 * OPEN: real offenders become invisible to a security guard, silently.
 * `codeOfSeesStatements` below is the tripwire.
 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Tokens that belong to the REMOVED EMPLOYEE SYNC and to nothing else.
 *
 * These are banned EVERYWHERE, with no exceptions and no allowance below -
 * including inside the sanctioned attendance integration. They are the
 * employee sync's own function names and its own feature flag, so a file
 * that contains one is either the sync returning or something imitating it.
 */
const GONE_EVERYWHERE = [
  "syncDigismeEmployees",
  "_fetchDigismeEmployees",
  "_authenticateDigisme",
  "getDigismeToken",
  "DIGISME_EMPLOYEE_SYNC",
  // The employee endpoint itself. The attendance integration calls
  // /api/GetRawAttendance and must never reach for the employee master:
  // dnds.co.in is the master (Stage 0C / C2).
  "GetEmployeeDetails",
];

/**
 * Tokens that are the VENDOR'S, not the employee sync's: the gateway host,
 * the two credential names and the gateway's payload cipher.
 *
 * The employee sync had no monopoly on these, and banning them outright is
 * what made this guard collide with an approved integration. They stay
 * banned everywhere EXCEPT the files named in SANCTIONED below.
 */
const GONE_UNLESS_SANCTIONED = [
  "DIGISME_API_KEY",
  "DIGISME_CUSTOM_KEY",
  "indhrmsgateway",
  "encryptAES",
];

/**
 * THE ONE SANCTIONED DIGISME INTEGRATION.
 *
 * "DigiSME attendance API -> dnds attendance ingest", approved and
 * documented in docs/digisme-attendance-api-sync.md. It reads punches from
 * /api/GetRawAttendance and hands them to the existing attendance ingest
 * path. It never writes the employee master.
 *
 * ONE FILE, LISTED EXPLICITLY, BY DESIGN. Everything else in that
 * integration - usecase/digisme_attendance_sync.js, the repository, the
 * store - talks to the vendor only through this client, and therefore needs
 * none of these tokens. If a second file ever appears here, that is a
 * design change worth arguing about in review, which is exactly the
 * conversation this list is meant to force.
 *
 * ADDING A FILE HERE IS NOT A FORMALITY. Ask first: does it genuinely need
 * to speak the vendor's protocol, or is it reaching for credentials it
 * should not have?
 */
const SANCTIONED = {
  "services/digisme_attendance.js": {
    why: "the /GetRawAttendance client - the only file that speaks to the DigiSME gateway",
    allows: GONE_UNLESS_SANCTIONED,
  },
  // The cipher's own definition. It contains its own name, which is not a
  // use of it; who may CALL it is asserted separately, below.
  "utils/encryptAES.js": {
    why: "defines the gateway's payload encoding - callers are constrained separately",
    allows: ["encryptAES"],
  },
};

/** Back-compat for the assertions further down that scan a single file. */
const GONE = [...GONE_EVERYWHERE, ...GONE_UNLESS_SANCTIONED];

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

describe("the scanner itself still works", () => {
  // Every assertion in this file is only as good as codeOf(). If a stray
  // comment blinds it, each scan below passes by seeing NOTHING - the worst
  // possible failure mode for a guardrail. These are the canaries.

  it("codeOf keeps statements while dropping comments", () => {
    const sample = [
      "/** a block comment mentioning DIGISME_API_KEY */",
      "// a line comment mentioning indhrmsgateway",
      'const real = require("../utils/encryptAES");',
      "const kept = 1;",
    ].join("\n");
    const out = codeOf(sample);
    assert.ok(out.includes('require("../utils/encryptAES")'), "statements must survive");
    assert.ok(out.includes("const kept = 1;"));
    assert.ok(!out.includes("DIGISME_API_KEY"), "block comments must go");
    assert.ok(!out.includes("indhrmsgateway"), "line comments must go");
  });

  it("no shipped file hides code behind a stray /* inside a line comment", () => {
    // The hazard is real: writing a glob inside a // comment opens a block
    // comment that swallows every statement up to the next close.
    const offenders = [];
    for (const f of sourceFiles()) {
      for (const [i, line] of read(f).split("\n").entries()) {
        const t = line.trim();
        if (t.startsWith("//") && t.includes("/" + "*")) offenders.push(`${f}:${i + 1}`);
      }
    }
    assert.deepEqual(offenders, [], "a line comment containing a block-comment opener blinds codeOf()");
  });

  it("the scan actually reaches the file it is meant to police", () => {
    // If this stops finding the sanctioned client's own require, the scan
    // has been blinded and every other assertion here is vacuous.
    const client = codeOf(read("services/digisme_attendance.js"));
    assert.match(client, /require\(["'][^"']*encryptAES["']\)/, "codeOf() can no longer see the client's requires");
    assert.ok(client.includes("DIGISME_API_KEY"), "codeOf() can no longer see the client's credential reads");
    assert.ok(sourceFiles().includes(path.join("services", "digisme_attendance.js")), "the client must be in scope");
  });
});

describe("no Digisme employee-sync code is left anywhere", () => {
  it("no shipped file references the sync or the employee endpoint - no exceptions", () => {
    // Not narrowable. Even the sanctioned attendance client fails this if it
    // ever grows employee-sync code.
    const offenders = [];
    for (const f of sourceFiles()) {
      const code = codeOf(read(f));
      for (const gone of GONE_EVERYWHERE) {
        if (code.includes(gone)) offenders.push(`${f}: ${gone}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("only the sanctioned attendance client uses the vendor's credentials, host or cipher", () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      const allowed = (SANCTIONED[f] && SANCTIONED[f].allows) || [];
      const code = codeOf(read(f));
      for (const gone of GONE_UNLESS_SANCTIONED) {
        if (code.includes(gone) && !allowed.includes(gone)) offenders.push(`${f}: ${gone}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a file outside docs/digisme-attendance-api-sync.md's integration is reaching for DigiSME credentials"
    );
  });

  it("the sanctioned list is exactly one file, and that file exists", () => {
    // The allowance is worth only as much as its narrowness. If this number
    // grows, someone widened the hole - make them justify it.
    const files = Object.keys(SANCTIONED);
    assert.deepEqual(files, ["services/digisme_attendance.js", "utils/encryptAES.js"]);
    assert.deepEqual(
      SANCTIONED["services/digisme_attendance.js"].allows,
      GONE_UNLESS_SANCTIONED,
      "the client is the only file allowed the vendor's credentials and host"
    );
    assert.deepEqual(
      SANCTIONED["utils/encryptAES.js"].allows,
      ["encryptAES"],
      "the cipher's definition gets no credential allowance"
    );
    for (const f of files) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is sanctioned but does not exist - stale allowance`);
      assert.ok(SANCTIONED[f].why, `${f} must say why it is sanctioned`);
    }
  });

  it("the sanctioned client reads punches and never writes the employee master", () => {
    // What earns the allowance, asserted rather than assumed.
    const code = codeOf(read("services/digisme_attendance.js"));
    assert.match(code, /GetRawAttendance/, "it must be the attendance endpoint");
    for (const gone of GONE_EVERYWHERE) {
      assert.ok(!code.includes(gone), `the sanctioned client must not reference ${gone}`);
    }
    // No employee-master write, by any of the routes the old sync used.
    for (const forbidden of ["bulkCreate", "new_employee", "designationUsecase", "outletUsecase", "employeeUsecase"]) {
      assert.ok(!code.includes(forbidden), `the sanctioned client must not touch the employee master (${forbidden})`);
    }
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

  it("the vendor cipher is required by the attendance client and by nothing else", () => {
    // WHAT CHANGED AND WHY. This used to assert NO caller at all, which was
    // true the day the employee sync was deleted and stopped being true when
    // the approved attendance integration landed.
    //
    // utils/encryptAES.js is NOT one of our security primitives. It is the
    // DigiSME gateway's PAYLOAD ENCODING: every /api/<Endpoint> call carries
    // its parameters as `{ str: encryptAES(payload) }`, and the key and IV
    // are values the gateway itself fixes - the IV is literally the
    // gateway vendor's own name. They are not ours to choose, they are not
    // secret, and they give the payload NO confidentiality: anyone holding
    // this file can decrypt it.
    //
    // Which is exactly why the allowance stays this narrow. The rule is:
    // encode vendor REQUEST PARAMETERS with it (CompanyId, fromDate,
    // toDate) and nothing else. It must never be used to protect anything
    // that actually needs protecting - see config/aadhaar.js, which says so
    // in its own header and uses a real cipher instead.
    const users = sourceFiles()
      .filter((f) => f !== path.join("utils", "encryptAES.js"))
      .filter((f) => /require\(["'][^"']*encryptAES["']\)/.test(codeOf(read(f))));
    assert.deepEqual(
      users,
      ["services/digisme_attendance.js"],
      "utils/encryptAES.js has a fixed key and IV and offers no confidentiality: only the DigiSME gateway client may use it"
    );
  });

  it("the cipher is used ONLY to encode vendor request parameters", () => {
    // The payload must stay parameters. A credential passed through this
    // function would be published in plaintext to anyone reading the code.
    const code = codeOf(read("services/digisme_attendance.js"));
    const calls = [...code.matchAll(/encryptAES\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(calls.length > 0, "expected the client to encode its payload");
    for (const arg of calls) {
      assert.ok(
        !/API_KEY|CUSTOM_KEY|token|Authorization|password|secret/i.test(arg),
        `encryptAES must never be handed a credential (saw: ${arg})`
      );
    }
    // And the credentials travel where the vendor puts them - in headers,
    // over TLS - not inside the encoded blob.
    assert.match(code, /Authorization: API_KEY/);
    assert.match(code, /customKey: CUSTOM_KEY/);
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
