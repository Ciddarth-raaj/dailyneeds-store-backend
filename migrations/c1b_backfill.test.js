/**
 * Stage 0C / C1b — the backfill's rules, as written in its SQL.
 *
 * The behaviour is proved against a real MySQL by the rehearsal; what this
 * file pins are the properties that make the backfill safe to run at all, and
 * which a careless edit would quietly remove:
 *
 *   * it writes only to employee_employment_period
 *   * it never invents a joining date - not from created_at, not from the
 *     resignation date, not from today
 *   * it cannot create a second period for an employee who has one
 *   * it uses %M, not %b (which silently loses "05 September 2021")
 *   * no expected count is hard-coded anywhere in the script
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "auth", "c1b-backfill.js");
const source = fs.readFileSync(SCRIPT, "utf8");
const { JOINED_ON, UNPARSEABLE, INSERT_SQL, CONFIRM_APPLY, CONFIRM_ROLLBACK } = require(SCRIPT);

/** The script's own code, with comment lines removed. */
const code = source
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
  .join("\n");

describe("C1b writes nothing but periods", () => {
  it("never writes to new_employee", () => {
    assert.ok(!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?new_employee`?/i.test(code));
  });

  it("its only INSERT targets employee_employment_period", () => {
    const inserts = code.match(/INSERT\s+INTO\s+[`\w]+/gi) || [];
    assert.equal(inserts.length, 1, `expected one INSERT, found ${inserts.length}`);
    assert.match(inserts[0], /employee_employment_period/i);
  });

  it("its only DELETE is the rollback, restricted to its own rows", () => {
    const deleteLines = code.split("\n").filter((l) => /DELETE\s+FROM/i.test(l));
    assert.equal(deleteLines.length, 1, `expected one DELETE, found ${deleteLines.length}`);
    assert.match(deleteLines[0], /employee_employment_period WHERE source = 'backfill'/i);
  });

  it("writes no lifecycle event", () => {
    assert.ok(!/INSERT\s+INTO\s+`?employee_lifecycle_event`?/i.test(code));
  });
});

describe("C1b never invents a joining date", () => {
  const joined = JOINED_ON("ne");

  it("reads only date_of_joining", () => {
    assert.match(joined, /date_of_joining/);
    for (const forbidden of ["created_at", "updated_at", "resignation_date", "NOW()", "CURDATE()"]) {
      assert.ok(!joined.includes(forbidden), `${forbidden} must not appear in the joining-date rule`);
    }
  });

  it("leaves NULL and blank as unknown", () => {
    assert.match(joined, /IS NULL OR TRIM\(ne\.date_of_joining\) = ''\s*THEN NULL/);
  });

  it("uses %M and never %b", () => {
    // %b parses "23 May 2024" but returns NULL for "05 September 2021" and
    // "05 Sept 2021", turning two readable dates into unknowns.
    assert.ok(joined.includes("'%d %M %Y'"));
    assert.ok(!joined.includes("%b"));
  });

  it("has a matching rule for values it cannot read", () => {
    assert.match(UNPARSEABLE("ne"), /IS NOT NULL/);
    assert.match(UNPARSEABLE("ne"), /IS NULL/);
    assert.ok(UNPARSEABLE("ne").includes("date_of_joining"));
  });

  it("aborts rather than dropping an unreadable date", () => {
    assert.match(code, /cannot be parsed\. Nothing has been written/);
    // the abort must happen in preflight, before the insert exists in the flow
    assert.ok(code.indexOf("cannot be parsed") < code.indexOf("== applying"));
  });
});

describe("C1b is idempotent by construction", () => {
  it("skips any employee who already has a period", () => {
    assert.match(
      INSERT_SQL,
      /WHERE NOT EXISTS \(\s*SELECT 1 FROM employee_employment_period p WHERE p\.employee_id = ne\.employee_id\s*\)/
    );
  });

  it("always writes period_no 1 and source 'backfill'", () => {
    assert.match(INSERT_SQL, /ne\.employee_id,\s*\n\s*1,/);
    assert.match(INSERT_SQL, /'backfill'/);
  });

  it("maps status and dates exactly as the rule states", () => {
    assert.match(INSERT_SQL, /CASE WHEN ne\.status = 1 THEN 'open' ELSE 'closed' END/);
    assert.match(INSERT_SQL, /CASE WHEN ne\.status = 1 THEN NULL ELSE ne\.resignation_date END/);
    assert.match(INSERT_SQL, /CASE WHEN ne\.status = 1 THEN NULL ELSE 'unknown' END/);
  });

  it("flags both kinds of unknown for review", () => {
    assert.match(INSERT_SQL, /IS NULL THEN 1/);
    assert.match(INSERT_SQL, /ne\.status <> 1 AND ne\.resignation_date IS NULL THEN 1/);
  });
});

describe("C1b refuses to guess, and refuses to be run by accident", () => {
  it("both mutating modes need their confirmation word", () => {
    assert.equal(CONFIRM_APPLY, "APPLY-C1B-BACKFILL");
    assert.equal(CONFIRM_ROLLBACK, "ROLLBACK-C1B-BACKFILL");
    assert.match(code, /apply needs --confirm/);
    assert.match(code, /rollback needs --confirm/);
  });

  it("asserts the date locale before reading anything", () => {
    assert.match(code, /@@lc_time_names/);
    assert.match(code, /refusing to run/);
  });

  it("stops on lifecycle data it did not create", () => {
    assert.match(code, /were not created by this backfill/);
    assert.match(code, /period_no <> 1/);
    assert.match(code, /disagree with what this run would write/);
  });

  it("hard-codes no expected employee count", () => {
    // Every total is read from the target at run time: the rehearsal copy had
    // 629 employees while production had 630, so a literal would be wrong
    // somewhere. The constants that DO appear are structural - LEFT(...,10)
    // for the ISO prefix, 3306 for the default port - so this asserts the
    // specific thing that must never be baked in: a population-sized number.
    const suspicious = (code.match(/\b\d{3,4}\b/g) || []).filter(
      (n) => Number(n) >= 100 && Number(n) <= 9999 && n !== "3306"
    );
    assert.deepEqual(suspicious, [], `possible hard-coded counts: ${suspicious.join(", ")}`);
    for (const n of ["629", "630"]) {
      assert.ok(!code.includes(n), `${n} must never appear - counts come from the target`);
    }
  });
});
