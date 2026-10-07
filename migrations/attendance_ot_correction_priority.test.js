/**
 * Migration 20261126120000 - attendance correction before system OT.
 *
 *   node --test migrations/attendance_ot_correction_priority.test.js
 *
 * The SQL as written; the behaviour is proved on real SQL in
 * repository/attendance_ot_auto_pending.mysql.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20261126120000-attendance-ot-correction-priority";
const dir = path.join(__dirname, "mysql/migrations");
const up = fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8").replace(/^\s*--.*$/gm, "");
const down = fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8").replace(/^\s*--.*$/gm, "");

describe(`migration ${NAME}`, () => {
  it("has a js wrapper that runs both files, and sorts after every OT migration", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, "")).sort();
    assert.equal(all[all.length - 1], NAME, "the newest migration");
  });

  it("a SYSTEM OT gets its own open-request group; manual requests keep theirs", () => {
    assert.match(up, /MODIFY COLUMN `open_request_group` ENUM\('ATT','SHIFT','PERM','AUTO_OT'\) GENERATED/);
    assert.match(up, /WHEN `request_type` = 'OT' AND `auto_created` = 1 THEN 'AUTO_OT'/);
    // In place, in ONE statement: never a drop-then-add that could fail half-way.
    assert.ok(!/DROP COLUMN `open_request_group`/.test(up));
    assert.ok(!/DROP INDEX `uq_aareq_open_per_employee_date`/.test(up));
  });

  it("at most ONE pending OT-carrying request a date, system or manual", () => {
    assert.match(up, /`open_ot_attendance_date` DATE GENERATED ALWAYS AS\s*\(CASE WHEN `status` = ''PENDING'' AND `request_type` IN \(''OT'',''REGULARIZATION_WITH_OT''\)/);
    assert.match(up, /UNIQUE KEY `uq_aareq_open_ot_per_employee_date`\s*\(`requested_for_employee_id`, `open_ot_attendance_date`\)/);
    assert.match(up, /`COLUMN_NAME` = 'open_ot_attendance_date'\) = 0/, "guarded: a re-run is harmless");
  });

  it("the deferred re-evaluation is a trigger table: one row per employee and date, never an OT record", () => {
    assert.match(up, /CREATE TABLE IF NOT EXISTS `attendance_ot_deferred_sync`/);
    assert.match(up, /UNIQUE KEY `uq_aods_employee_date` \(`employee_id`, `attendance_date`\)/);
    assert.match(up, /`status` ENUM\('WAITING_FOR_CORRECTION','RESOLVED'\)/);
    assert.match(up, /CREATE TABLE IF NOT EXISTS `attendance_ot_deferred_sync_log`/);
    assert.ok(!/candidate_ot_minutes|approved_ot_minutes/.test(up.slice(up.indexOf("attendance_ot_deferred_sync"))), "it holds no OT figure to pay");
  });

  it("rewrites no row, and the down reverses exactly that", () => {
    assert.ok(!/\bUPDATE\s+`?attendance_approval_request/i.test(up));
    assert.ok(!/\bDELETE\s+FROM/i.test(up));
    assert.match(down, /DROP TABLE IF EXISTS `attendance_ot_deferred_sync_log`/);
    assert.match(down, /DROP TABLE IF EXISTS `attendance_ot_deferred_sync`/);
    assert.match(down, /DROP INDEX `uq_aareq_open_ot_per_employee_date`,\s*DROP COLUMN `open_ot_attendance_date`/);
    assert.match(down, /MODIFY COLUMN `open_request_group` ENUM\('ATT','SHIFT','PERM'\) GENERATED/);
    assert.ok(!/DROP COLUMN `open_request_group`/.test(down), "a refused down changes nothing");
    assert.ok(down.indexOf("MODIFY COLUMN `open_request_group`") < down.indexOf("DROP INDEX `uq_aareq_open_ot_per_employee_date`"), "the groups first, so a refusal stops before anything is removed");
  });
});
