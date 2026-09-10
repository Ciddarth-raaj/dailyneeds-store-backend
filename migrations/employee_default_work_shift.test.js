/**
 * The employee -> work shift migration is additive, reversible, and leaves
 * the legacy shift columns completely alone.
 *
 *   node --test migrations/employee_default_work_shift.test.js
 *
 * Proven against the SQL text - there is no database here - which is the same
 * way `hr_permission_keys_b2.test.js` proves its migration. That suits what
 * matters most about this one: what it must NOT do. It must not backfill, it
 * must not read `shift_master`, `shift_code` or `shift_id`, and it must not
 * modify any existing column.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260910120000-employee-default-work-shift";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

describe("up", () => {
  const sql = read(`${NAME}-up.sql`);
  const stmts = statements(sql);

  it("is one ALTER TABLE on new_employee and nothing else", () => {
    assert.equal(stmts.length, 1);
    assert.match(stmts[0], /^ALTER TABLE `new_employee`/);
  });

  it("adds default_work_shift_id as a nullable INT defaulting to NULL", () => {
    assert.match(
      stmts[0],
      /ADD COLUMN `default_work_shift_id` INT NULL DEFAULT NULL/
    );
  });

  it("adds the foreign key onto work_shift, restricting deletes", () => {
    assert.match(
      stmts[0],
      /ADD CONSTRAINT `fk_new_employee_default_work_shift` FOREIGN KEY \(`default_work_shift_id`\) REFERENCES `work_shift` \(`work_shift_id`\) ON DELETE RESTRICT ON UPDATE RESTRICT/
    );
  });

  it("adds its own named index for the key and the UNASSIGNED filter", () => {
    assert.match(stmts[0], /ADD INDEX `idx_new_employee_default_work_shift` \(`default_work_shift_id`\)/);
  });

  it("BACKFILLS NOTHING - every statement is the ALTER, none writes a row", () => {
    // Checked per statement rather than by searching the text, because
    // `ON UPDATE RESTRICT` is part of the foreign key and contains the word.
    for (const s of stmts) {
      assert.ok(!/^(UPDATE|INSERT|REPLACE|SELECT|SET)\b/i.test(s), `not a data statement: ${s}`);
    }
  });

  it("NEVER MENTIONS THE LEGACY SHIFT COLUMNS OR TABLE", () => {
    const body = stripComments(sql);
    assert.ok(!/shift_master/.test(body), "shift_master is not touched");
    assert.ok(!/`shift_id`/.test(body), "shift_id is not touched");
    assert.ok(!/`shift_code`/.test(body), "shift_code is not touched");
  });

  it("modifies or drops nothing that already exists", () => {
    const body = stripComments(sql).toUpperCase();
    assert.ok(!/\bMODIFY\b/.test(body), "no MODIFY");
    assert.ok(!/\bCHANGE\b/.test(body), "no CHANGE");
    assert.ok(!/\bDROP\b/.test(body), "no DROP");
  });
});

describe("down", () => {
  const sql = read(`${NAME}-down.sql`);
  const stmts = statements(sql);

  it("drops exactly what the up added, and only from new_employee", () => {
    assert.equal(stmts.length, 2);
    for (const s of stmts) assert.match(s, /^ALTER TABLE `new_employee`/);
    assert.match(stmts[0], /DROP FOREIGN KEY `fk_new_employee_default_work_shift`/);
    assert.match(stmts[1], /DROP INDEX `idx_new_employee_default_work_shift`/);
    assert.match(stmts[1], /DROP COLUMN `default_work_shift_id`/);
  });

  it("drops the constraint before the index it uses", () => {
    const fk = sql.indexOf("DROP FOREIGN KEY");
    const idx = sql.indexOf("DROP INDEX");
    assert.ok(fk !== -1 && idx !== -1 && fk < idx);
  });

  it("leaves the legacy shift columns alone on the way down too", () => {
    const body = stripComments(sql);
    assert.ok(!/shift_master/.test(body));
    assert.ok(!/`shift_id`/.test(body));
    assert.ok(!/`shift_code`/.test(body));
  });
});

describe("the runner", () => {
  const runner = fs.readFileSync(
    path.join(__dirname, "mysql/migrations", `${NAME}.js`),
    "utf8"
  );

  it("reads the two sql files this migration owns", () => {
    assert.ok(runner.includes(`'sqls', '${NAME}-up.sql'`));
    assert.ok(runner.includes(`'sqls', '${NAME}-down.sql'`));
  });
});
