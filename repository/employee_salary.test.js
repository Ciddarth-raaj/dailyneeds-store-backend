/**
 * M2 — what the salary repository may and may not do.
 *
 *   node --test repository/employee_salary.test.js
 *
 * Two kinds of assertion. The SQL-shape ones are read off the source, because
 * what matters about them is that the statement cannot be written a different
 * way - "no salary delete" is a rule about code that does not exist. The
 * behavioural ones run the methods against a fake connection that records the
 * SQL and the bound parameters, which is how the immutability scoping and the
 * resolver's ordering are proved without a database.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const buildRepo = require("./employee_salary");
const { SALARY_COLUMNS } = require("./employee_salary");

const source = fs.readFileSync(require.resolve("./employee_salary"), "utf8");

/**
 * The source with its COMMENTS REMOVED.
 *
 * The prose in that file explains the rules it keeps, so it naturally
 * contains the words "DELETE", "TRUNCATE" and "SELECT *". Asserting against
 * the raw text would fail on the documentation rather than on the code, and -
 * worse - would pass the day somebody deleted the comment. The assertions
 * below are about what the file DOES.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/** A connection that records every query and answers with canned rows. */
function makeDb(rows = []) {
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, rows);
    },
  };
}

describe("no salary delete", () => {
  it("the repository issues no DELETE or TRUNCATE anywhere", () => {
    // The rule this file exists to keep. A salary history that can be deleted
    // is not a history, and the audit value of the table comes entirely from
    // rows that cannot quietly disappear.
    assert.ok(!/\bDELETE\s+FROM\b/i.test(code), "no DELETE");
    assert.ok(!/\bTRUNCATE\b/i.test(code), "no TRUNCATE");
    assert.ok(!/\bDROP\b/i.test(code), "no DROP");
  });

  it("exposes no method that sounds like one", () => {
    const repo = buildRepo(makeDb());
    for (const name of ["delete", "deleteSalary", "remove", "removeSalary", "destroy", "purge"]) {
      assert.equal(typeof repo[name], "undefined", `${name} must not exist`);
    }
  });
});

describe("no SELECT *", () => {
  it("every column is named", () => {
    assert.ok(!/SELECT\s+\*/i.test(code), "a star select is how a later column leaks to a screen");
  });

  it("the column list covers the whole approved schema", () => {
    for (const column of [
      "monthly_gross",
      "basic",
      "conveyance",
      "hra",
      "special_allowance",
      "manual_override",
      "override_reason",
      "employee_pf",
      "employer_epf",
      "employer_eps",
      "edli",
      "pf_admin_charge",
      "employee_esi",
      "employer_esi",
      "monthly_ctc",
      "effective_from",
      "status",
      "source",
      "statutory_snapshot",
    ]) {
      assert.ok(SALARY_COLUMNS.includes(column), `${column} is selectable`);
    }
  });
});

describe("the statutory context read", () => {
  it("reads five statutory columns and a name — not the employee's documents", async () => {
    const db = makeDb([{ employee_id: 1 }]);
    await buildRepo(db).getStatutoryContext(1);
    const sql = db.calls[0].sql;

    for (const wanted of [
      "pf_applicable",
      "esi_applicable",
      "previous_pf_member",
      "dob",
      "date_of_joining",
    ]) {
      assert.ok(sql.includes(wanted), `${wanted} is read`);
    }
    // Calculating somebody's provident fund is not a reason to read their
    // identity documents, their bank account or the legacy salary string.
    for (const forbidden of [
      "aadhaar",
      "pan_no",
      "account_no",
      "ifsc",
      "bank_name",
      "`salary`",
    ]) {
      assert.ok(!sql.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} is not read`);
    }
  });

  it("parses date_of_joining through the SHARED rule, not a second one", async () => {
    // `utils/joining_date.js` is the one rule for reading that VARCHAR, and
    // the C1b lifecycle backfill used it. Parsing it a second way here would
    // let M2 and the lifecycle disagree about when somebody joined, which
    // would move the opening salary's effective date.
    const { JOINED_ON } = require("../utils/joining_date");
    assert.ok(code.includes("JOINED_ON"), "the shared expression is used");
    const db = makeDb([{}]);
    await buildRepo(db).getStatutoryContext(1);
    const normalize = (s) => s.replace(/\s+/g, " ").trim();
    assert.ok(
      db.calls[0].sql.includes(normalize(JOINED_ON("ne"))),
      "the emitted SQL carries the shared expression verbatim"
    );
  });
});

describe("the current-salary query", () => {
  it("asks only for APPROVED rows effective on or before the date, latest first", async () => {
    const db = makeDb([]);
    await buildRepo(db).getCurrentSalary(42, "2026-06-01");
    const { sql, params } = db.calls[0];

    assert.match(sql, /`status` = \?/);
    assert.match(sql, /`effective_from` <= \?/);
    assert.match(sql, /ORDER BY s\.`effective_from` DESC, s\.`salary_id` DESC/);
    assert.match(sql, /LIMIT 1/);
    assert.deepEqual(params, [42, "APPROVED", "2026-06-01"]);
  });

  it("binds every value rather than interpolating it", () => {
    // No template-literal interpolation of a caller's value anywhere near a
    // WHERE clause: the only interpolations in this file are the column list
    // and the shared joining-date expression, both of them constants.
    assert.ok(!/\$\{(employeeId|salaryId|asOfDate|effectiveFrom|reason)\}/.test(code));
  });
});

describe("immutability is enforced in the SQL, not only in the service", () => {
  it("an amendment is scoped to PENDING", async () => {
    const db = makeDb({ affectedRows: 0 });
    await buildRepo(db).updatePending(1, { basic: 1 });
    const { sql, params } = db.calls[0];
    assert.match(sql, /WHERE `salary_id` = \? AND `status` = \?/);
    assert.equal(params[params.length - 1], "PENDING");
  });

  it("an approval is scoped to PENDING", async () => {
    const db = makeDb({ affectedRows: 0 });
    await buildRepo(db).approve(1, 7);
    const { sql, params } = db.calls[0];
    assert.match(sql, /AND `status` = \?/);
    assert.equal(params[params.length - 1], "PENDING");
    assert.ok(sql.includes("`approved_at` = CURRENT_TIMESTAMP"), "the clock is the database's");
  });

  it("a rejection is scoped to PENDING and stores its reason", async () => {
    const db = makeDb({ affectedRows: 0 });
    await buildRepo(db).reject(1, 7, "Wrong grade");
    const { sql, params } = db.calls[0];
    assert.match(sql, /AND `status` = \?/);
    assert.ok(params.includes("Wrong grade"));
    assert.equal(params[params.length - 1], "PENDING");
  });

  it("nothing updates a row without naming its status", () => {
    // Every UPDATE in this file carries `AND \`status\` = ?`. An UPDATE that
    // did not would be able to rewrite approved history.
    // Backticks inside a template literal are written escaped, so the raw
    // source spells the same SQL two ways. Dropping the backslashes first
    // makes one pattern match both.
    const flat = code.replace(/\\`/g, "`");
    const chunks = flat.split(/UPDATE\s+`employee_salary`/).slice(1);
    assert.equal(chunks.length, 3, "there are exactly three update paths");
    for (const chunk of chunks) {
      // Far enough to cover the WHERE clause of any of the three.
      const stmt = chunk.slice(0, 400);
      assert.ok(/status` = \?/.test(stmt), `an UPDATE without a status guard: ${stmt.slice(0, 80)}`);
    }
  });
});

describe("the live-salary test excludes rejected rows", () => {
  it("asks for a row whose status is not REJECTED", async () => {
    const db = makeDb([]);
    await buildRepo(db).hasLiveSalary(42);
    const { sql, params } = db.calls[0];
    assert.match(sql, /`status` <> \?/);
    assert.deepEqual(params, [42, "REJECTED"]);
  });
});
