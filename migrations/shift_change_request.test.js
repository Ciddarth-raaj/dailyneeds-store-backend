/**
 * The shift-change migration: ADDITIVE, guarded, reversible.
 *
 *   node --test migrations/shift_change_request.test.js
 *
 * What is defended is that this migration adds concepts to tables that exist
 * rather than building a parallel set of them, that it drops and rewrites
 * nothing, and that the one index it replaces is replaced by a strictly wider
 * one - so no pair that could not both be open before can now.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const NAME = "20261029120000-shift-change-request";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("sorts after every migration that existed when it was written", () => {
    const others = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js") && f !== `${NAME}.js`)
      .map((f) => f.replace(/\.js$/, ""));
    for (const other of others) {
      assert.ok(other < NAME, `${other} must sort before this migration`);
    }
  });

  it("CREATES NO TABLE - every concept extends one that exists", () => {
    assert.equal(up.filter((s) => /^CREATE TABLE/i.test(s)).length, 0);
    // The four it extends, and no others.
    const altered = up
      .filter((s) => /^ALTER TABLE/i.test(s))
      .map((s) => /^ALTER TABLE `([a-z_]+)`/.exec(s)[1]);
    assert.deepEqual([...new Set(altered)].sort(), [
      "attendance_approval_request",
      "attendance_approval_step",
      "attendance_date_shift_override",
      "attendance_day_calculation",
      "employee_work_shift_assignment",
    ]);
  });

  it("REWRITES NO ROW and DROPS NO COLUMN", () => {
    for (const statement of up) {
      assert.ok(!/^UPDATE|^DELETE|^TRUNCATE|^DROP TABLE/i.test(statement), statement.slice(0, 60));
      assert.ok(!/DROP COLUMN/i.test(statement), statement.slice(0, 60));
    }
  });

  it("the calculated day carries the PAYROLL BASE beside its own NRM", () => {
    const [calc] = up.filter((s) => /^ALTER TABLE `attendance_day_calculation`/.test(s));
    for (const column of ["base_nrm_minutes", "base_work_shift_id", "regular_minutes"]) {
      assert.match(calc, new RegExp(`ADD COLUMN \`${column}\``), column);
    }
    // The day's own NRM is untouched: the two are separate figures, not one
    // figure with a new meaning.
    assert.ok(!/MODIFY COLUMN `nrm_minutes`/.test(calc));
  });

  it("SHIFT_CHANGE joins the request enum rather than getting a table of its own", () => {
    const [request] = up.filter((s) => /^ALTER TABLE `attendance_approval_request` MODIFY/.test(s));
    assert.match(
      request,
      /MODIFY COLUMN `request_type` ENUM\('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE'\)/
    );
    assert.match(request, /ADD COLUMN `requested_work_shift_id`/);
    assert.match(request, /ADD COLUMN `base_work_shift_id`/);
  });

  it("the open-request key is WIDENED, never narrowed: shift stands apart, attendance and OT stay together", () => {
    const [keyChange] = up.filter((s) => /uq_aareq_open_per_employee_date/.test(s) && /ADD UNIQUE KEY/.test(s));
    assert.match(
      keyChange,
      /open_request_group` ENUM\('ATT','SHIFT'\) GENERATED ALWAYS AS \(CASE WHEN `status` = 'PENDING' THEN \(CASE WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT' ELSE 'ATT' END\) ELSE NULL END\) STORED/
    );
    assert.match(
      keyChange,
      /ADD UNIQUE KEY `uq_aareq_open_per_employee_date` \(`requested_for_employee_id`, `open_attendance_date`, `open_request_group`\)/
    );
    // The old key is dropped in the SAME statement as the new one is added,
    // so there is no window with no key at all.
    assert.match(keyChange, /DROP INDEX `uq_aareq_open_per_employee_date`/);
  });

  it("a step records WHERE it was decided, and the column is nullable for the steps that are not", () => {
    const [step] = up.filter((s) => /^ALTER TABLE `attendance_approval_step`/.test(s));
    assert.match(step, /ADD COLUMN `decision_source` ENUM\('WEB','TELEGRAM'\) NULL/);
  });

  it("an approved request writes through the EXISTING override table, and the row names its authority", () => {
    const [override] = up.filter((s) => /^ALTER TABLE `attendance_date_shift_override`/.test(s));
    assert.match(override, /ADD COLUMN `attendance_approval_request_id`/);
    assert.match(override, /ADD COLUMN `source` ENUM\('DIRECT','APPROVED_REQUEST'\) NOT NULL DEFAULT 'DIRECT'/);
    assert.match(override, /ADD COLUMN `reason`/);
  });

  it("the permanent history gains a SOURCE and keeps every row it had", () => {
    const [assignment] = up.filter((s) => /^ALTER TABLE `employee_work_shift_assignment`/.test(s));
    assert.match(
      assignment,
      /MODIFY COLUMN `source` ENUM\('MIGRATION_BACKFILL','ASSIGNMENT','BULK_ASSIGNMENT','CORRECTION','SHIFT_CHANGE'\)/
    );
    // The note becomes the reason and is only ever WIDENED - 255 to 500 - so
    // no existing note can be truncated by this migration.
    assert.match(assignment, /MODIFY COLUMN `note` VARCHAR\(500\) NULL/);
  });

  it("declares its four permission keys and grants them to NOBODY", () => {
    const declared = up.filter((s) => /^INSERT INTO `all_permissions`/i.test(s));
    assert.equal(declared.length, 4);
    for (const key of [
      "edit_shift_assignment_effective_dated",
      "raise_shift_change_request",
      "approve_shift_change_request",
      "view_shift_change_requests",
    ]) {
      assert.ok(declared.some((s) => s.includes(`'${key}'`)), key);
      assert.ok(declared.every((s) => /WHERE NOT EXISTS/.test(s)), "each insert is guarded");
    }
    // Nothing is GRANTED: a key reaches a designation only on the rights
    // screen, deliberately.
    assert.equal(up.filter((s) => /^INSERT INTO `permissions`/i.test(s)).length, 0);
  });

  it("the down file reverses every column, and deletes only permissions nobody holds", () => {
    const dropped = down.join(" ");
    for (const column of [
      "regular_minutes", "base_work_shift_id", "base_nrm_minutes",
      "requested_work_shift_id", "telegram_chat_id", "telegram_message_id",
      "decision_source", "source", "reason", "attendance_approval_request_id",
      "open_request_group",
    ]) {
      assert.match(dropped, new RegExp(`DROP COLUMN \`${column}\``), column);
    }
    const [permissionDelete] = down.filter((s) => /^DELETE FROM `all_permissions`/.test(s));
    assert.match(permissionDelete, /AND NOT EXISTS \( SELECT 1 FROM `permissions`/);
    // And it puts the original unique key back.
    assert.match(
      dropped,
      /ADD UNIQUE KEY `uq_aareq_open_per_employee_date` \(`requested_for_employee_id`, `open_attendance_date`\)/
    );
  });
});
