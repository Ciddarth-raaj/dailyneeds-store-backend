/**
 * 20261107120000-employee-attendance-calculation-mode, as SQL text.
 *
 *   node --test migrations/employee_attendance_calculation_mode.test.js
 *
 * The backward-compatibility guarantee is in this file's shape: one new
 * append-only table with NO backfill (so every employee resolves to
 * SHIFT_BASED), one new column whose default states what every existing row
 * already is, and nothing rewritten, granted or revoked.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20261107120000-employee-attendance-calculation-mode";
const DIR = path.join(__dirname, "mysql/migrations");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const statements = (sql) =>
  sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

const up = statements(read(`sqls/${NAME}-up.sql`));
const down = statements(read(`sqls/${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = read(`${NAME}.js`);
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("creates the history table append-only-shaped: no unique key, the resolver's index", () => {
    const create = up.find((s) => /^CREATE TABLE IF NOT EXISTS `employee_attendance_calculation_mode`/.test(s));
    assert.ok(create);
    assert.match(create, /`calculation_mode` ENUM\('SHIFT_BASED','PRESENT_ABSENT_ONLY'\) NOT NULL/);
    assert.match(create, /`effective_from`\s+DATE NOT NULL/);
    assert.match(create, /KEY `idx_eacm_employee_effective` \(`employee_id`, `effective_from`\)/);
    assert.doesNotMatch(create, /UNIQUE/);
  });

  it("backfills NOTHING - no row means SHIFT_BASED, so the mode is opt-in", () => {
    assert.equal(up.filter((s) => /^(INSERT|UPDATE|DELETE|REPLACE)/i.test(s)).length, 0);
  });

  it("adds the provenance column with SHIFT_BASED as the default for every existing row", () => {
    const alter = up.find((s) => /^ALTER TABLE `attendance_day_calculation`/.test(s));
    assert.match(
      alter,
      /ADD COLUMN `attendance_calculation_mode` ENUM\('SHIFT_BASED','PRESENT_ABSENT_ONLY'\) NOT NULL DEFAULT 'SHIFT_BASED'/
    );
    assert.equal(up.filter((s) => /^ALTER/i.test(s)).length, 1, "no other table is altered");
    assert.equal(up.filter((s) => /^DROP|^TRUNCATE/i.test(s)).length, 0);
  });

  it("the column is written by every guarded attendance write", () => {
    const repo = fs.readFileSync(path.join(__dirname, "..", "repository/attendance_calculation.js"), "utf8");
    assert.match(repo, /"attendance_calculation_mode",\n\];/);
  });

  it("down removes exactly what up added", () => {
    assert.deepEqual(down, [
      "ALTER TABLE `attendance_day_calculation` DROP COLUMN `attendance_calculation_mode`",
      "DROP TABLE IF EXISTS `employee_attendance_calculation_mode`",
    ]);
  });
});
