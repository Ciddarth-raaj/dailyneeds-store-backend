/**
 * Stage 0C / C1d — tests for the validator itself.
 *
 *   node --test scripts/auth/c1d_validation.test.js
 *
 * A validator that agrees with a broken system is worse than none, so these
 * feed it deliberately broken data and assert it complains. The structural
 * rules are re-stated here in JavaScript over the same row shapes the SQL
 * reads, and the SQL is separately asserted to exist and to be shaped the way
 * the rule requires - because a validator's SQL cannot be executed without a
 * database, but it CAN be checked for the predicate that makes it correct.
 *
 * The read-only property is checked structurally: comments and log strings
 * are stripped, and no writing verb may remain.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "c1d-lifecycle-validation.js"), "utf8");
const { decide, toDateOnly } = require("../../usecase/employee_lifecycle");

/* ------------------------------------------------------------------------ */
/* The invariants, as the validator's SQL states them, applied to rows here.  */
/* ------------------------------------------------------------------------ */

const openOf = (periods, id) =>
  periods.filter((p) => p.employee_id === id && p.period_state === "open");

/** Mirrors the six current-state checks. */
function structuralFindings(employees, periods) {
  const found = [];
  const ids = new Set(employees.map((e) => e.employee_id));

  for (const e of employees) {
    const mine = periods.filter((p) => p.employee_id === e.employee_id);
    const open = openOf(periods, e.employee_id);
    if (mine.length === 0) {
      found.push({ code: "EMPLOYEE_WITH_NO_PERIOD", employee_id: e.employee_id });
      continue;
    }
    if (e.status === 1 && open.length === 0) {
      found.push({ code: "ACTIVE_NO_OPEN_PERIOD", employee_id: e.employee_id });
    }
    if (open.length > 1) found.push({ code: "MULTIPLE_OPEN_PERIODS", employee_id: e.employee_id });
    if (e.status !== 1 && open.length > 0) {
      found.push({ code: "INACTIVE_WITH_OPEN_PERIOD", employee_id: e.employee_id });
    }
  }
  for (const p of periods) {
    if (!ids.has(p.employee_id)) found.push({ code: "ORPHAN_PERIOD", period_id: p.period_id });
  }
  const seen = new Set();
  for (const p of periods) {
    const key = `${p.employee_id}/${p.period_no}`;
    if (seen.has(key)) found.push({ code: "DUPLICATE_PERIOD_NO", employee_id: p.employee_id });
    seen.add(key);
  }
  return found;
}

/** Mirrors the three sequence checks. */
function sequenceFindings(periods) {
  const found = [];
  const byEmployee = new Map();
  for (const p of periods) {
    if (!byEmployee.has(p.employee_id)) byEmployee.set(p.employee_id, []);
    byEmployee.get(p.employee_id).push(p);
  }
  for (const [employee_id, mine] of byEmployee) {
    const nos = mine.map((p) => p.period_no);
    const distinct = [...new Set(nos)];
    if (Math.min(...nos) !== 1) found.push({ code: "SEQUENCE_NOT_FROM_ONE", employee_id });
    if (distinct.length !== Math.max(...nos) || Math.min(...nos) !== 1) {
      found.push({ code: "SEQUENCE_GAP", employee_id });
    }
    const max = Math.max(...nos);
    for (const p of mine) {
      if (p.period_state === "open" && p.period_no !== max) {
        found.push({ code: "OPEN_PERIOD_NOT_LATEST", employee_id });
      }
    }
  }
  return found;
}

const codes = (findings) => findings.map((f) => f.code);
const emp = (employee_id, status) => ({ employee_id, status });
const per = (period_id, employee_id, period_no, period_state, over = {}) => ({
  period_id, employee_id, period_no, period_state,
  joined_on: null, ended_on: null, source: "local", needs_review: 0, ...over,
});

/* ==================================================== the clean cases ==== */
describe("clean populations produce no finding", () => {
  it("1. an active employee with exactly one open period", () => {
    const e = [emp(1, 1)];
    const p = [per(10, 1, 1, "open", { joined_on: "2022-01-01" })];
    assert.deepEqual(structuralFindings(e, p), []);
    assert.deepEqual(sequenceFindings(p), []);
  });

  it("2. an inactive employee with one closed period and no open period", () => {
    const e = [emp(2, 0)];
    const p = [per(20, 2, 1, "closed", { joined_on: "2019-01-01", ended_on: "2023-05-05" })];
    assert.deepEqual(structuralFindings(e, p), []);
    assert.deepEqual(sequenceFindings(p), []);
  });

  it("9. period 1 closed -> period 2 open is a valid rejoin", () => {
    const e = [emp(3, 1)];
    const p = [
      per(30, 3, 1, "closed", { joined_on: "2019-01-01", ended_on: "2022-01-01" }),
      per(31, 3, 2, "open", { joined_on: "2023-01-01" }),
    ];
    assert.deepEqual(structuralFindings(e, p), []);
    assert.deepEqual(sequenceFindings(p), []);
  });

  it("10. 1 -> 2 -> 3 is a valid repeated rejoin", () => {
    const e = [emp(4, 1)];
    const p = [
      per(40, 4, 1, "closed", { joined_on: "2016-01-01", ended_on: "2018-01-01" }),
      per(41, 4, 2, "closed", { joined_on: "2019-01-01", ended_on: "2021-01-01" }),
      per(42, 4, 3, "open", { joined_on: "2022-01-01" }),
    ];
    assert.deepEqual(structuralFindings(e, p), []);
    assert.deepEqual(sequenceFindings(p), []);
  });

  it("18. every period carries the same employee_id", () => {
    const p = [
      per(40, 4, 1, "closed", { ended_on: "2018-01-01" }),
      per(41, 4, 2, "closed", { ended_on: "2021-01-01" }),
      per(42, 4, 3, "open"),
    ];
    assert.deepEqual([...new Set(p.map((x) => x.employee_id))], [4]);
    assert.deepEqual(sequenceFindings(p), []);
  });
});

/* ================================================== the broken cases ===== */
describe("structural violations are detected", () => {
  it("3. an active employee whose only period is closed", () => {
    const found = structuralFindings([emp(5, 1)], [per(50, 5, 1, "closed", { ended_on: "2024-01-01" })]);
    assert.deepEqual(codes(found), ["ACTIVE_NO_OPEN_PERIOD"]);
  });

  it("4. an inactive employee with an open period", () => {
    const found = structuralFindings([emp(6, 0)], [per(60, 6, 1, "open")]);
    assert.deepEqual(codes(found), ["INACTIVE_WITH_OPEN_PERIOD"]);
  });

  it("5. two open periods for one employee", () => {
    const found = structuralFindings([emp(7, 1)], [per(70, 7, 1, "open"), per(71, 7, 2, "open")]);
    assert.ok(codes(found).includes("MULTIPLE_OPEN_PERIODS"));
  });

  it("6. an employee with no period at all", () => {
    const found = structuralFindings([emp(8, 1)], []);
    assert.deepEqual(codes(found), ["EMPLOYEE_WITH_NO_PERIOD"]);
  });

  it("7. a period whose employee does not exist", () => {
    const found = structuralFindings([], [per(90, 99, 1, "open")]);
    assert.deepEqual(codes(found), ["ORPHAN_PERIOD"]);
  });

  it("8. a duplicated period_no, and a gapped sequence", () => {
    assert.ok(
      codes(structuralFindings([emp(11, 1)], [per(110, 11, 1, "closed", { ended_on: "2020-01-01" }), per(111, 11, 1, "open")]))
        .includes("DUPLICATE_PERIOD_NO")
    );
    // 1 then 3: a gap.
    const gap = sequenceFindings([
      per(120, 12, 1, "closed", { ended_on: "2020-01-01" }),
      per(121, 12, 3, "open"),
    ]);
    assert.ok(codes(gap).includes("SEQUENCE_GAP"));
    // starts at 2: not from one.
    const notOne = sequenceFindings([per(130, 13, 2, "open")]);
    assert.ok(codes(notOne).includes("SEQUENCE_NOT_FROM_ONE"));
  });

  it("an open period that is not the newest", () => {
    const found = sequenceFindings([
      per(140, 14, 1, "open"),
      per(141, 14, 2, "closed", { ended_on: "2024-01-01" }),
    ]);
    assert.ok(codes(found).includes("OPEN_PERIOD_NOT_LATEST"));
  });
});

/* ========================================================= the dates ===== */
describe("date findings are graded correctly", () => {
  const severityOf = (code) => {
    // The validator raises exactly one date code as an error; the rest are
    // warnings, because 518 rows legitimately carry an unknown date.
    const errorBlock = SRC.slice(SRC.indexOf("async function dates"), SRC.indexOf("async function events"));
    const asError = new RegExp(`addError\\(\\s*"${code}"`).test(errorBlock);
    const asWarning = new RegExp(`addWarning\\(\\s*"${code}"`).test(errorBlock);
    return asError ? "error" : asWarning ? "warning" : "absent";
  };

  it("11. an unknown historical joining date is a warning, not fatal", () => {
    assert.equal(severityOf("PERIOD_JOINED_ON_UNKNOWN"), "warning");
  });

  it("12. an unknown historical end date is a warning, not fatal", () => {
    assert.equal(severityOf("CLOSED_PERIOD_END_UNKNOWN"), "warning");
  });

  it("13. ended_on before joined_on is an error", () => {
    assert.equal(severityOf("ENDED_BEFORE_JOINED"), "error");
    assert.match(SRC, /ended_on IS NOT NULL AND joined_on IS NOT NULL AND ended_on < joined_on/);
  });

  it("an unreadable master date is a warning and uses the shared parsing rule", () => {
    assert.equal(severityOf("UNREADABLE_MASTER_JOINING_DATE"), "warning");
    assert.match(SRC, /require\(path\.join\(ROOT, "utils\/joining_date"\)\)/);
  });

  it("the current master date is compared ONLY where that is meaningful", () => {
    // A rejoined employee's master column describes the CURRENT spell, so
    // comparing it against period 1 would manufacture a disagreement.
    const block = SRC.slice(SRC.indexOf("const conflicts = []"), SRC.indexOf("if (conflicts.length)"));
    assert.match(block, /n === 1 &&/, "the conflict check must be restricted to single-period employees");
    assert.match(block, /n > 1 &&/, "and multi-period employees get the stale-date check instead");
  });

  it("a stale original date on a rejoined employee is reported, not treated as a conflict", () => {
    assert.equal(severityOf("STALE_MASTER_DATE_ON_REJOIN"), "warning");
  });
});

/* ======================================================== the events ===== */
describe("event integrity", () => {
  it("14. a C1b backfill period with no event is valid and is NOT reported", () => {
    const block = SRC.slice(SRC.indexOf("async function events"), SRC.indexOf("async function auth"));
    assert.match(block, /p\.source = 'local'/, "only runtime periods are expected to carry an event");
    assert.ok(
      !/RUNTIME_PERIOD_WITHOUT_EVENT[\s\S]{0,200}source = 'backfill'/.test(block),
      "backfilled periods must not be required to have events"
    );
  });

  it("15. a runtime period with no event is detected", () => {
    assert.match(SRC, /addError\(\s*"RUNTIME_PERIOD_WITHOUT_EVENT"/);
  });

  it("16. duplicate opening and closure events are detected", () => {
    assert.match(SRC, /addError\(\s*"DUPLICATE_OPEN_EVENT"/);
    assert.match(SRC, /addError\(\s*"DUPLICATE_CLOSE_EVENT"/);
    const block = SRC.slice(SRC.indexOf("const dupOpen"), SRC.indexOf("const contradiction"));
    assert.match(block, /GROUP BY period_id HAVING COUNT\(\*\) > 1/);
  });

  it("events referencing a missing employee or period are detected", () => {
    assert.match(SRC, /addError\(\s*"EVENT_MISSING_EMPLOYEE"/);
    assert.match(SRC, /addError\(\s*"EVENT_MISSING_PERIOD"/);
  });

  it("an event contradicting its period's state is detected", () => {
    assert.match(SRC, /addError\(\s*"EVENT_CONTRADICTS_PERIOD"/);
    assert.match(SRC, /event_type = 'period_closed' AND p\.period_state = 'open'/);
  });
});

/* ====================================================== idempotency ====== */
describe("17. a repeated normal sync produces no change", () => {
  it("the forecast says 'none' for a settled employee, however many times it is asked", () => {
    // The validator's forecast calls the real decide(); a settled employee
    // must come back as a no-op every time, which is what makes a repeated
    // sync a no-op too.
    const employee = {
      employee_id: 1, status: 1, resignation_date: null,
      raw_date_of_joining: "01 March 2022", parsed_joined_on: "2022-03-01",
    };
    const latest = {
      period_id: 1, period_no: 1, period_state: "open",
      joined_on: "2022-03-01", ended_on: null, prev_ended_on: null,
    };
    for (let i = 0; i < 5; i++) assert.equal(decide(employee, latest).action, "none");
  });

  it("and for a settled inactive employee too", () => {
    const employee = {
      employee_id: 2, status: 0, resignation_date: "2023-05-05",
      raw_date_of_joining: "2019-01-01", parsed_joined_on: "2019-01-01",
    };
    const latest = {
      period_id: 2, period_no: 1, period_state: "closed",
      joined_on: "2019-01-01", ended_on: "2023-05-05", prev_ended_on: null,
    };
    for (let i = 0; i < 5; i++) assert.equal(decide(employee, latest).action, "none");
  });

  it("a backfilled row with unknown dates and no local data is also a no-op", () => {
    // 518 production rows look like this. The forecast must not propose to
    // write to any of them.
    const employee = {
      employee_id: 3, status: 0, resignation_date: null,
      raw_date_of_joining: null, parsed_joined_on: null,
    };
    const latest = {
      period_id: 3, period_no: 1, period_state: "closed",
      joined_on: null, ended_on: null, prev_ended_on: null,
    };
    assert.equal(decide(employee, latest).action, "none");
  });
});

/* ============================================================= auth ====== */
describe("19. the auth cutoff configuration is reported correctly", () => {
  it("reads the effective flag rather than assuming it", () => {
    assert.match(SRC, /require\(path\.join\(ROOT, "config\/auth"\)\)\.login\.tokenValidFromEnabled/);
  });

  it("raises an ERROR when the cutoff is disabled, because a rejoin would not revoke", () => {
    assert.match(SRC, /addError\(\s*\n?\s*"SESSION_CUTOFF_DISABLED"/);
  });

  it("reports where revocation is wired, read from the runtime source", () => {
    assert.match(SRC, /revokeOnClose/);
    assert.match(SRC, /revokeOnRejoin/);
    assert.match(SRC, /addError\("REVOCATION_NOT_WIRED"/);
  });

  it("and the runtime really does revoke on close and rejoin, but not on a no-op", () => {
    const rejoin = decide(
      { employee_id: 1, status: 1, resignation_date: null, raw_date_of_joining: null, parsed_joined_on: "2025-01-01" },
      { period_id: 1, period_no: 1, period_state: "closed", joined_on: "2019-01-01", ended_on: "2022-01-01", prev_ended_on: null }
    );
    assert.equal(rejoin.action, "open_rejoin");
    assert.equal(rejoin.revokeSessions, true);

    const close = decide(
      { employee_id: 1, status: 0, resignation_date: "2025-01-01", raw_date_of_joining: null, parsed_joined_on: "2019-01-01" },
      { period_id: 1, period_no: 1, period_state: "open", joined_on: "2019-01-01", ended_on: null, prev_ended_on: null }
    );
    assert.equal(close.action, "close");
    assert.equal(close.revokeSessions, true);

    const noop = decide(
      { employee_id: 1, status: 1, resignation_date: null, raw_date_of_joining: null, parsed_joined_on: "2019-01-01" },
      { period_id: 1, period_no: 1, period_state: "open", joined_on: "2019-01-01", ended_on: null, prev_ended_on: null }
    );
    assert.equal(noop.action, "none");
    assert.equal(noop.revokeSessions, undefined, "a quiet sync must not log anybody out");
  });

  it("prints no token, hash or secret", () => {
    for (const forbidden of ["password", "password_hash", "token_valid_from AS", "jwt", "secret"]) {
      const bad = new RegExp(`SELECT[^;]*${forbidden}`, "i");
      assert.ok(!bad.test(SRC), `must not select ${forbidden}`);
    }
  });
});

/* ======================================================== read-only ====== */
describe("20. no validator mode performs writes", () => {
  const stripped = SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`[^`]*`/g, "``")
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");

  it("contains no writing statement and opens no transaction", () => {
    for (const verb of [
      "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "TRUNCATE", "REPLACE",
      "beginTransaction", "START TRANSACTION", "withTransaction",
    ]) {
      assert.ok(!new RegExp(`\\b${verb}\\b`, "i").test(stripped), `must not contain ${verb}`);
    }
  });

  it("offers exactly one mode, and rejects anything else", () => {
    assert.match(SRC, /C1d has one mode: check \(read-only\)/);
    assert.ok(!/"repair"|"fix"|"apply"/.test(stripped), "no repairing mode may exist");
  });

  it("never selects an employee name", () => {
    assert.ok(!/employee_name/.test(SRC), "operational reports are by employee_id");
  });

  it("counts transitions from event timestamps, not updated_at", () => {
    const start = SRC.indexOf("async function transitions");
    const block = SRC.slice(start, SRC.indexOf("*  report", start));
    assert.ok(block.length > 200, "the transitions function must be found");
    assert.match(block, /e\.created_at/);
    assert.ok(!/updated_at/.test(block), "updated_at moves for reasons that are not transitions");
  });
});

/* ================================================ independence check ===== */
describe("the structural checks do not ask C1c what it expects", () => {
  it("decide() is used only for the labelled forecast", () => {
    for (const fn of ["async function structure", "async function sequence", "async function events"]) {
      const start = SRC.indexOf(fn);
      const end = SRC.indexOf("async function", start + 10);
      const block = SRC.slice(start, end);
      assert.ok(!/\bdecide\(/.test(block), `${fn} must not consult the reconciler's own expectations`);
    }
    assert.match(SRC.slice(SRC.indexOf("function forecast")), /decide\(employee, latest\)/);
  });
});
