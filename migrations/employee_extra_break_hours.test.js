/**
 * `new_employee.extra_break_hours` - the column the Extra Break Hours setting
 * is stored in, proven against its own SQL.
 *
 *   node --test migrations/employee_extra_break_hours.test.js
 *
 * There is no database here, so this works the way the other migration tests
 * in this directory work: it reads the SQL text for the structural claims.
 * What matters about this migration is that it is PURELY ADDITIVE - it must
 * not backfill, must not default to a value, and must not touch any other
 * column - because that is what makes "0 or null = today's behaviour" true of
 * every employee who existed before it ran.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20261024120000-employee-extra-break-hours";
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

  it("is unique", () => {
    assert.equal(all.filter((f) => f === NAME).length, 1);
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
  });

  it("sorts after every migration that existed when it was written", () => {
    const WHEN_WRITTEN = "20261023120000-payrun-calculation";
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
  it("is one ALTER on new_employee and nothing else", () => {
    const statements = up.split(";").map(normalize).filter(Boolean);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^ALTER TABLE `new_employee`/);
  });

  it("adds exactly one column, and adds it", () => {
    assert.equal((up.match(/ADD COLUMN/g) || []).length, 1);
    assert.match(normalize(up), /ADD COLUMN `extra_break_hours`/);
  });

  it("is DECIMAL with two places, so half an hour comes back as 0.50 and not 0.4999", () => {
    assert.match(normalize(up), /`extra_break_hours` DECIMAL\(4,2\)/);
    assert.ok(!/FLOAT|DOUBLE/i.test(up));
  });

  it("is NULLable, defaults to NULL and backfills nothing", () => {
    assert.match(normalize(up), /`extra_break_hours` DECIMAL\(4,2\) NULL DEFAULT NULL/);
    assert.ok(!/UPDATE|INSERT|SET `?extra_break_hours`? =/i.test(up), "no backfill");
    assert.ok(!/NOT NULL/i.test(up));
  });

  it("touches no other column and no other table", () => {
    assert.ok(!/DROP|MODIFY|CHANGE/i.test(up));
    assert.equal((up.match(/ALTER TABLE/gi) || []).length, 1);
    assert.equal((normalize(up).match(/`new_employee`/g) || []).length, 1);
  });
});

describe("down", () => {
  it("drops the one column it added, and only that", () => {
    const statements = down.split(";").map(normalize).filter(Boolean);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^ALTER TABLE `new_employee` DROP COLUMN `extra_break_hours`$/);
  });
});
