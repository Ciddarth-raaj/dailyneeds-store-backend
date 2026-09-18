/**
 * `attendance_day_calculation`'s two break-provenance columns, proven against
 * their own SQL.
 *
 *   node --test migrations/attendance_break_provenance.test.js
 *
 * Written during the release sync, because the migration had no test of its
 * own and the sync had to prove migration replay and ordering for all three
 * of the feature's migrations. It asserts what the other migration tests in
 * this directory assert: the runner reads its own files, the change is purely
 * additive, and nothing is backfilled - which is what makes the columns safe
 * to add to a table production is already writing.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20261025120000-attendance-break-provenance";
const dir = path.join(__dirname, "mysql/migrations");
const sqlDir = path.join(dir, "sqls");
const read = (f) => fs.readFileSync(path.join(sqlDir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const normalize = (s) => s.replace(/\s+/g, " ").trim();

const up = stripComments(read(`${NAME}-up.sql`));
const down = stripComments(read(`${NAME}-down.sql`));

describe("the migration identifier", () => {
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));

  it("is unique - db-migrate runs a file once, by its full name", () => {
    assert.equal(all.filter((f) => f === NAME).length, 1);
  });

  it("sorts after every migration that existed when it was written", () => {
    // Including the two that share the 20261024 timestamp: this one needs
    // `attendance_day_calculation` to exist, and nothing needs this one.
    const WHEN_WRITTEN = "20261024120000-payrun-calculation-column-drift";
    const earlier = all.filter((f) => f !== NAME && f <= WHEN_WRITTEN).sort();
    assert.ok(NAME > earlier[earlier.length - 1]);
  });

  it("the runner reads its own up and down files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });
});

describe("up", () => {
  it("is one ALTER on attendance_day_calculation and nothing else", () => {
    const statements = up.split(";").map(normalize).filter(Boolean);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^ALTER TABLE `attendance_day_calculation`/);
    assert.equal((up.match(/ALTER TABLE/gi) || []).length, 1);
  });

  it("adds exactly the two provenance columns", () => {
    assert.equal((up.match(/ADD COLUMN/g) || []).length, 2);
    assert.match(normalize(up), /ADD COLUMN `break_override_minutes_applied` INT NULL DEFAULT NULL/);
    assert.match(normalize(up), /ADD COLUMN `extra_break_minutes_applied` INT NULL DEFAULT NULL/);
  });

  it("backfills nothing and drops nothing - an existing row keeps NULL in both", () => {
    assert.ok(!/UPDATE|INSERT/i.test(up), "no backfill: what an old calculation applied cannot be proven");
    assert.ok(!/DROP|MODIFY|CHANGE/i.test(up));
    assert.ok(!/NOT NULL/i.test(up));
  });
});

describe("down", () => {
  it("drops the two columns it added, and only those", () => {
    const statements = down.split(";").map(normalize).filter(Boolean);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^ALTER TABLE `attendance_day_calculation` DROP COLUMN/);
    assert.equal((down.match(/DROP COLUMN/g) || []).length, 2);
  });
});
