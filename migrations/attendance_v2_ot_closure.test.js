/**
 * The OT closure migration: one nullable column, nothing else.
 *
 *   node --test migrations/attendance_v2_ot_closure.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const statements = (sql) =>
  sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const NAME = "20260921120000-attendance-v2-ot-closure";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("adds ONE nullable column to attendance_approval_request and changes nothing else", () => {
    assert.equal(up.length, 1);
    assert.match(up[0], /^ALTER TABLE `attendance_approval_request` ADD COLUMN `closure_reason`/);
    assert.match(up[0], /NULL DEFAULT NULL/);
    assert.ok(!/\b(MODIFY|CHANGE|DROP|RENAME)\b/i.test(up[0]));
  });

  it("names exactly the two payroll-lock closures", () => {
    assert.match(up[0], /ENUM\('NOT_REQUESTED_BEFORE_PAYROLL_LOCK','NOT_APPROVED_BEFORE_PAYROLL_LOCK'\)/);
  });

  it("does not remove REGULARIZATION_WITH_OT from the request_type enum (historical rows keep reading)", () => {
    assert.ok(!/request_type/.test(up[0]));
  });

  it("never touches a Biomax punch table or a permission", () => {
    up.forEach((s) => assert.ok(!/biomax_punch|permissions/i.test(s)));
  });

  it("the down drops exactly that column", () => {
    assert.deepEqual(down, ["ALTER TABLE `attendance_approval_request` DROP COLUMN `closure_reason`"]);
  });
});
