/**
 * The revocation-outcome migration: three NULLable columns on the revocation
 * audit, nothing else.
 *
 *   node --test migrations/attendance_approval_revocation_outcome.test.js
 *
 * Its behaviour - what a Shift revoke writes into them - is the MariaDB
 * suite's (`repository/attendance_shift_revoke.mysql.test.js`), which builds
 * the table from this file.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const NAME = "20261106120000-attendance-approval-revocation-outcome";
const read = (f) => fs.readFileSync(path.join(dir, "sqls", f), "utf8");
const statements = (sql) =>
  sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

describe(NAME, () => {
  it("up: one ALTER of the revocation audit adding three NULLable columns - no data written", () => {
    const up = statements(read(`${NAME}-up.sql`));
    assert.equal(up.length, 1);
    assert.match(up[0], /^ALTER TABLE `attendance_approval_revocation` /);
    for (const col of ["new_request_status` VARCHAR\\(16\\) NULL", "reopened_stage_no` INT NULL", "withdrawn_override_ids` JSON NULL"]) {
      assert.match(up[0], new RegExp("ADD COLUMN `" + col));
    }
    assert.ok(!/\b(DROP|INSERT|UPDATE|DELETE)\b/i.test(up[0]));
  });

  it("down: drops exactly those three columns", () => {
    const down = statements(read(`${NAME}-down.sql`));
    assert.deepEqual(down, [
      "ALTER TABLE `attendance_approval_revocation` DROP COLUMN `withdrawn_override_ids`, DROP COLUMN `reopened_stage_no`, DROP COLUMN `new_request_status`",
    ]);
  });

  it("the db-migrate wrapper runs this migration's own files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`'${NAME}-up.sql'`));
    assert.match(js, new RegExp(`'${NAME}-down.sql'`));
  });
});
