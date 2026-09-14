/**
 * The DN-ATTENDANCE migration: additive, reversible, and inventing no history.
 *
 *   node --test migrations/attendance_required_and_shift_history_repair.test.js
 *
 * Proven against the SQL text, the way every other migration here is. What
 * matters most is what it must NOT do: it must not rewrite an existing
 * value, must not date an assignment before the v2 cutover, and must not
 * touch an employee who already has dated history.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260930120000-attendance-required-and-shift-history-repair";
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
  const body = stripComments(sql).replace(/\s+/g, " ");

  it("adds attendance_required as NOT NULL DEFAULT 1, so every existing employee still requires attendance", () => {
    const alter = stmts.find((s) => /ADD COLUMN `attendance_required`/.test(s));
    assert.ok(alter, "the column is added");
    assert.match(alter, /ALTER TABLE `new_employee`/);
    assert.match(alter, /`attendance_required` TINYINT\(1\) NOT NULL DEFAULT 1/);
  });

  it("adds name_as_per_aadhaar to the IDENTITY row, not to new_employee", () => {
    const alter = stmts.find((s) => /ADD COLUMN `name_as_per_aadhaar`/.test(s));
    assert.ok(alter);
    assert.match(alter, /ALTER TABLE `employee_aadhaar_identity`/);
    assert.ok(!/new_employee`? ADD COLUMN `name_as_per_aadhaar/.test(body));
  });

  it("backfills the Aadhaar name from the verification already on file, inventing none", () => {
    const update = stmts.find((s) => /UPDATE `employee_aadhaar_identity`/.test(s));
    assert.ok(update);
    assert.match(update, /demographics_json/, "it reads the payload that already exists");
    assert.match(update, /i\.`name_as_per_aadhaar` IS NULL/, "never overwrites a value");
    assert.match(update, /<> ''/, "a blank name is not stored as a verified name");
  });

  it("repairs assignment history ONLY for employees who have none", () => {
    const insert = stmts.find((s) => /INSERT INTO `employee_work_shift_assignment`/.test(s));
    assert.ok(insert);
    assert.match(insert, /NOT EXISTS \( SELECT 1 FROM `employee_work_shift_assignment` a WHERE a\.`employee_id` = ne\.`employee_id` \)/);
    assert.match(insert, /ne\.`default_work_shift_id` IS NOT NULL/, "unassigned stays unassigned");
  });

  it("dates the repaired row at the joining date but never before the v2 cutover", () => {
    const insert = stmts.find((s) => /INSERT INTO `employee_work_shift_assignment`/.test(s));
    assert.match(insert, /GREATEST\( '2026-09-01'/);
    assert.match(insert, /date_of_joining/);
  });

  it("never UPDATEs or DELETEs an existing assignment row - history is append-only", () => {
    assert.ok(!/UPDATE `employee_work_shift_assignment`/.test(body));
    assert.ok(!/DELETE FROM `employee_work_shift_assignment`/.test(body));
  });

  it("declares the VIEW permission only - there is no grantable key for CHANGING the flag", () => {
    assert.match(body, /INSERT INTO `all_permissions`/);
    assert.match(body, /'view_attendance_required'/);
    assert.ok(
      !/edit_attendance_required|change_attendance_required|manage_attendance_required/.test(body),
      "changing it is administrators only, and an administrator cannot grant that away"
    );
  });

  it("grants nothing to any designation", () => {
    assert.ok(!/INSERT INTO `designation_permissions`/.test(body));
    assert.ok(!/INSERT INTO `permissions`/.test(body));
  });
});

describe("down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("drops both columns and the declared key", () => {
    assert.ok(stmts.some((s) => /DROP COLUMN `attendance_required`/.test(s)));
    assert.ok(stmts.some((s) => /DROP COLUMN `name_as_per_aadhaar`/.test(s)));
    assert.ok(stmts.some((s) => /DELETE FROM `all_permissions`/.test(s)));
  });

  it("does NOT delete the backfilled assignment history", () => {
    // By the time anybody rolls back, attendance may have been calculated
    // against those rows. Deleting them would silently move settled figures.
    assert.ok(!stmts.some((s) => /employee_work_shift_assignment/.test(s)));
  });
});
