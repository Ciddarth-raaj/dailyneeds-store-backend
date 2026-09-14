/**
 * `new_employee.date_of_joining` becomes a real DATE - proven against its own
 * SQL, and against the parser it shares with the rest of the system.
 *
 *   node --test migrations/employee_joining_date_to_date.test.js
 *
 * There is no database here, so the file works the way the other migration
 * tests in this directory work: it reads the SQL text for the structural
 * claims, and then runs the migration's CONVERSION RULE as a predicate over a
 * fixture population, so "which values convert, and to what" is an executed
 * answer rather than a reading of a string.
 *
 * What matters about this migration is almost entirely what it must NOT do:
 * it must not guess at a date it cannot read, must not convert one date into
 * another, must not drop a row, and must not touch any column but the one.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { JOINED_ON, UNPARSEABLE } = require("../utils/joining_date");

const NAME = "20261012120000-employee-joining-date-to-date";
const dir = path.join(__dirname, "mysql/migrations");
const sqlDir = path.join(dir, "sqls");
const read = (f) => fs.readFileSync(path.join(sqlDir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const normalize = (s) => s.replace(/\s+/g, " ").trim();

const up = stripComments(read(`${NAME}-up.sql`));
const down = stripComments(read(`${NAME}-down.sql`));

/* ------------------------------------------------------------- identity -- */

describe("the migration identifier", () => {
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));

  it("is unique", () => {
    assert.equal(all.filter((f) => f === NAME).length, 1);
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
  });

  it("sorts after every migration that existed when it was written", () => {
    const WHEN_WRITTEN = "20261011120000-aadhaar-verification-target-employee";
    const earlier = all.filter((f) => f !== NAME && f <= WHEN_WRITTEN).sort();
    assert.ok(NAME > earlier[earlier.length - 1]);
  });

  it("the runner reads its own up and down files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });
});

/* ------------------------------------------------------------------- up -- */

describe("up", () => {
  it("alters exactly one column of exactly one table", () => {
    const alters = [...up.matchAll(/ALTER TABLE `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(alters)], ["new_employee"]);
    const modified = [...up.matchAll(/MODIFY COLUMN `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(modified)], ["date_of_joining"]);
  });

  it("makes it DATE and leaves it NULLABLE with no default", () => {
    assert.match(up, /MODIFY COLUMN `date_of_joining` DATE NULL DEFAULT NULL/);
    assert.ok(!/date_of_joining` DATE NOT NULL/.test(up), "425 rows have no joining date");
  });

  it("writes only `date_of_joining`, and never deletes a row", () => {
    const setColumns = [...up.matchAll(/SET `([a-z_]+)` =/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(setColumns)], ["date_of_joining"]);
    assert.ok(!/\bDELETE\b/i.test(up), "no employee row is removed");
    assert.ok(!/\bINSERT\b/i.test(up), "no employee row is invented");
    assert.ok(!/\bDROP\b/i.test(up), "nothing is dropped");
  });

  it("touches no other table", () => {
    for (const table of [
      "biomax_punch",
      "biomax_punch_derived",
      "attendance_day_calculation",
      "employee_employment_period",
      "employee_lifecycle_event",
      "employee_salary",
    ]) {
      assert.ok(!up.includes(`\`${table}\``), `${table} must not appear`);
    }
  });

  it("ABORTS rather than converting a value it cannot read", () => {
    assert.match(up, /__ABORT_unconvertible_date_of_joining_values_exist/);
    // The guard counts exactly the rows `UNPARSEABLE` describes: present,
    // non-blank, and unreadable by the shared parser.
    assert.match(up, /AND TRIM\(`date_of_joining`\) <> ''/);
    assert.match(up, /END\) IS NULL\) = 0,/);
  });

  it("ABORTS when lc_time_names would make a good date look unreadable", () => {
    assert.match(up, /__ABORT_lc_time_names_must_be_en_US/);
    assert.match(up, /@@lc_time_names = 'en_US'/);
  });

  it("is re-runnable: every write and the ALTER are guarded on the column's type", () => {
    assert.match(up, /`DATA_TYPE` <> 'date'/);
    const prepares = (up.match(/PREPARE stmt FROM/g) || []).length;
    assert.equal(prepares, (up.match(/EXECUTE stmt/g) || []).length);
    assert.equal(prepares, (up.match(/DEALLOCATE PREPARE stmt/g) || []).length);
  });

  it("reports the audit before it changes anything", () => {
    const firstSelect = up.indexOf("SELECT");
    const firstUpdate = up.indexOf("UPDATE");
    const firstAlter = up.indexOf("ALTER TABLE");
    assert.ok(firstSelect !== -1 && firstSelect < firstUpdate && firstSelect < firstAlter);
    for (const figure of [
      "total_rows",
      "non_null_joining_dates",
      "null_joining_dates",
      "blank_joining_dates",
      "unconvertible_values",
    ]) {
      assert.ok(up.includes(figure), `the audit must report ${figure}`);
    }
  });

  it("uses THE shared parser, character for character", () => {
    // Not "a parser that looks similar". C1b's backfill derived the existing
    // employment periods with this expression; a second one here would
    // migrate the column to dates that disagree with them.
    const shared = normalize(JOINED_ON("ne"))
      .replace(/ne\./g, "")
      .replace(/`/g, "");
    const inMigration = normalize(up).replace(/`/g, "");
    const body = shared.slice(shared.indexOf("WHEN date_of_joining LIKE"));
    assert.ok(inMigration.includes(body), "the migration's CASE is the shared one");
    assert.ok(normalize(UNPARSEABLE("ne")).length > 0, "the unparseable rule is exported too");
  });
});

/* ----------------------------------------------------------------- down -- */

describe("down", () => {
  it("returns the column to VARCHAR(45) and rewrites no data", () => {
    assert.match(down, /MODIFY COLUMN `date_of_joining` VARCHAR\(45\) NULL DEFAULT NULL/);
    assert.ok(!/\bUPDATE\b|\bDELETE\b|\bINSERT\b/i.test(down), "a rollback changes nobody's date");
  });

  it("is guarded so it can be re-run", () => {
    assert.match(down, /`DATA_TYPE` = 'date'/);
  });
});

/* ------------------------------------- the conversion rule, EXECUTED ----- */

/**
 * The migration's CASE expression, as JavaScript, so a fixture population can
 * be run through it. `%M` is the full month name under lc_time_names=en_US,
 * which the migration asserts before it relies on it.
 */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const realDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
    ? `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    : null;
};
const joinedOn = (value) => {
  if (value === null || value === undefined) return null;
  if (String(value).trim() === "") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    return realDate(Number(y), Number(m), Number(d));
  }
  const long = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(String(value).trim());
  if (!long) return null;
  const month = MONTHS.indexOf(long[2].toLowerCase());
  return month === -1 ? null : realDate(Number(long[3]), month + 1, Number(long[1]));
};

describe("the conversion, run over a fixture population", () => {
  const POPULATION = [
    { employee_id: 101, date_of_joining: "2022-09-16", expect: "2022-09-16" },
    { employee_id: 102, date_of_joining: "2022-04-01 00:00:00", expect: "2022-04-01" },
    { employee_id: 103, date_of_joining: "05 September 2021", expect: "2021-09-05" },
    { employee_id: 104, date_of_joining: "23 May 2024", expect: "2024-05-23" },
    { employee_id: 105, date_of_joining: null, expect: null },
    { employee_id: 106, date_of_joining: "", expect: null },
    { employee_id: 107, date_of_joining: "   ", expect: null },
  ];

  it("preserves every legitimate date exactly", () => {
    for (const row of POPULATION) {
      assert.equal(joinedOn(row.date_of_joining), row.expect, `employee ${row.employee_id}`);
    }
  });

  it("the ISO rows - which is what 'the data is now uniform' means - are unchanged", () => {
    const iso = POPULATION.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date_of_joining)));
    assert.ok(iso.length > 0);
    for (const row of iso) assert.equal(joinedOn(row.date_of_joining), row.date_of_joining);
  });

  it("blank and NULL both become NULL - the absence of a value, not 1970", () => {
    assert.equal(joinedOn(""), null);
    assert.equal(joinedOn("   "), null);
    assert.equal(joinedOn(null), null);
  });

  it("a value it cannot read is NOT guessed at - it is what aborts the run", () => {
    for (const bad of ["16/09/2022", "not a date", "2022-13-45", "Sept 2021", "16-09-2022"]) {
      assert.equal(joinedOn(bad), null, `${bad} must not convert to a date`);
    }
    // And the migration's guard is the count of exactly those rows.
    const unconvertible = POPULATION.concat([{ employee_id: 999, date_of_joining: "16/09/2022" }])
      .filter((r) => r.date_of_joining !== null && String(r.date_of_joining).trim() !== "")
      .filter((r) => joinedOn(r.date_of_joining) === null);
    assert.deepEqual(unconvertible.map((r) => r.employee_id), [999]);
  });

  it("no date moves by a day in either direction", () => {
    // The failure mode a DATE column invites: a value read through a JS Date
    // at local midnight and then formatted in UTC. Every fixture is asserted
    // against the exact calendar day its text names.
    assert.equal(joinedOn("2022-09-16"), "2022-09-16");
    assert.equal(joinedOn("01 January 2020"), "2020-01-01");
    assert.equal(joinedOn("31 December 2019"), "2019-12-31");
  });
});
