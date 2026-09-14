/**
 * THE PRODUCTION JOINING-DATE AUDIT IS READ-ONLY, AND ASKS THE RIGHT
 * QUESTIONS.
 *
 *   node --test scripts/hr/joining_date_audit.test.js
 *
 * This file cannot run the audit - there is no database here, and that is
 * exactly the situation it is written for. What it CAN prove is the two
 * things that make it safe to hand the script to somebody with production
 * credentials:
 *
 *   1. it cannot write. Not "is not intended to write" - cannot: every
 *      top-level statement is a SELECT and no write keyword appears outside a
 *      comment anywhere in the file.
 *   2. it asks the same question the migration will act on. The audit and the
 *      migration share `utils/joining_date.js#JOINED_ON` character for
 *      character, so a clean audit is evidence about the migration rather
 *      than about a differently-worded query.
 *
 * And that it reports every figure the review asked for, so a missing section
 * fails here rather than in a deploy window.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { JOINED_ON } = require("../../utils/joining_date");

const AUDIT = path.join(__dirname, "joining-date-audit.sql");
const MIGRATION = path.join(
  __dirname,
  "../../migrations/mysql/migrations/sqls/20261012120000-employee-joining-date-to-date-up.sql"
);

const raw = fs.readFileSync(AUDIT, "utf8");
/** The file with every `--` comment removed: the code, not the prose. */
const code = raw.replace(/--[^\n]*/g, "");
const normalize = (s) => s.replace(/\s+/g, " ").trim();

/* ================================================== it cannot write ====== */

describe("STRICTLY READ-ONLY", () => {
  it("contains no write, DDL or session-changing keyword outside a comment", () => {
    for (const forbidden of [
      "UPDATE", "DELETE", "INSERT", "ALTER", "DROP", "CREATE", "REPLACE",
      "TRUNCATE", "GRANT", "REVOKE", "CALL", "PREPARE", "EXECUTE",
      "LOCK", "UNLOCK", "RENAME", "LOAD", "HANDLER", "DO ",
    ]) {
      assert.ok(
        !new RegExp(`\\b${forbidden.trim()}\\b`, "i").test(code),
        `${forbidden.trim()} must not appear in a read-only audit`
      );
    }
  });

  it("sets no session variable and creates no temporary table", () => {
    assert.ok(!/\bSET\b/i.test(code), "an audit that changes a session setting is not read-only");
    assert.ok(!/\bTEMPORARY\b/i.test(code));
    assert.ok(!/\bINTO\s+(OUTFILE|DUMPFILE|@)/i.test(code), "SELECT ... INTO writes");
  });

  it("every statement begins with SELECT", () => {
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    assert.ok(statements.length >= 8, "the audit must actually contain its sections");
    for (const statement of statements) {
      assert.match(statement, /^SELECT\b/i, `not a SELECT: ${statement.slice(0, 60)}`);
    }
  });

  it("reads only `new_employee` and information_schema", () => {
    const tables = [...code.matchAll(/\bFROM\s+([a-z_][a-z_0-9.]*)/gi)].map((m) => m[1].toLowerCase());
    const allowed = new Set(["new_employee", "information_schema.columns", "parsed"]);
    for (const table of tables) {
      assert.ok(allowed.has(table), `${table} is not part of this audit`);
    }
  });
});

/* ====================================== it asks the migration's question == */

describe("it audits what the migration will do", () => {
  const migration = fs.readFileSync(MIGRATION, "utf8");

  it("uses the SHARED parser, not a lookalike", () => {
    // The distinguishing body of `JOINED_ON`, with the table alias and the
    // backticks removed so the three spellings can be compared.
    const shared = normalize(JOINED_ON("ne")).replace(/ne\./g, "").replace(/`/g, "");
    const body = shared.slice(shared.indexOf("WHEN date_of_joining LIKE"));
    assert.ok(normalize(code).includes(body), "the audit's CASE is the shared one");
    assert.ok(
      normalize(migration).replace(/`/g, "").includes(body),
      "and so is the migration's - a clean audit must be evidence about the migration"
    );
  });

  it("uses the same blocking predicate the migration aborts on", () => {
    // Present, non-blank, and unreadable by the parser.
    assert.match(code, /TRIM\(date_of_joining\) <> ''/);
    assert.match(code, /END\) IS NULL/);
    assert.match(migration, /END\) IS NULL\) = 0,/);
  });

  it("checks the locale the parser depends on", () => {
    assert.match(code, /@@lc_time_names/);
    assert.match(migration, /@@lc_time_names = 'en_US'/);
  });
});

/* ============================================ it reports every figure ===== */

describe("it reports every figure the review asked for", () => {
  const REQUIRED = [
    ["total rows", /total_rows/],
    ["non-null rows", /non_null_rows/],
    ["null rows", /null_rows/],
    ["blank / whitespace-only rows", /blank_or_whitespace_rows/],
    ["distinct formats present", /format_shape/],
    ["count per format", /rows_with_this_shape/],
    ["invalid / unconvertible count", /unconvertible_values/],
    ["exact ids and values of invalid rows", /employee_id,\s*\n?\s*employee_name,\s*\n?\s*CONCAT\('\[', date_of_joining/],
    ["rows whose semantic date would change", /rows_whose_parsed_date_would_change_MUST_BE_ZERO/],
    ["what mysql reads today vs after", /what_mysql_reads_today[\s\S]*what_it_will_hold_after/],
    ["min valid joining date", /min_valid_joining_date/],
    ["max valid joining date", /max_valid_joining_date/],
  ];

  for (const [what, pattern] of REQUIRED) {
    it(`reports ${what}`, () => {
      assert.match(raw, pattern);
    });
  }

  it("distinguishes NULL from blank, which are different facts", () => {
    assert.match(code, /date_of_joining IS NULL/);
    assert.match(code, /TRIM\(date_of_joining\) = ''/);
  });

  it("uses LIKE rather than REGEXP for the format breakdown", () => {
    // The regex engine changed between MySQL 5.7 and 8; `_` did not. An audit
    // whose answer depends on the server version is not an audit.
    // The statement that produces `format_shape`, from its own SELECT.
    const aliasAt = code.indexOf("AS format_shape");
    const breakdown = code.slice(code.lastIndexOf("SELECT", aliasAt), code.indexOf("GROUP BY format_shape"));
    assert.ok(!/REGEXP/i.test(breakdown), "the format breakdown must not depend on the regex engine");
    assert.match(breakdown, /LIKE '____-__-__'/);
  });
});
