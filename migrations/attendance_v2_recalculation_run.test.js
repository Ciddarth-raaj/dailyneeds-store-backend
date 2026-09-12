/**
 * The bulk recalculation run audit: one new table, additive, no salary data.
 *
 *   node --test migrations/attendance_v2_recalculation_run.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const statements = (sql) =>
  sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const NAME = "20260922120000-attendance-v2-recalculation-run";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("creates ONE table, guarded, and nothing else", () => {
    assert.equal(up.length, 1);
    assert.match(up[0], /^CREATE TABLE IF NOT EXISTS `attendance_recalculation_run`/);
  });

  it("records who, when, which range and filters, the counts and the outcome", () => {
    for (const col of ["requested_by_employee_id", "started_at", "completed_at", "from_date", "to_date", "employee_id", "store_id", "designation_id", "employees_targeted", "employees_completed", "employees_failed", "days_processed", "status", "errors"]) {
      assert.match(up[0], new RegExp(`\`${col}\``), col);
    }
    assert.match(up[0], /ENUM\('RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED'\)/);
  });

  it("stores nothing sensitive: no salary, gross, pay or bank column", () => {
    assert.ok(!/\b(salary|gross|ctc|pay|bank|pf|esi|net)\b/i.test(up[0].replace(/COMMENT '[^']*'/g, "")));
  });

  it("touches no permission and no Biomax punch table", () => {
    up.forEach((s) => assert.ok(!/permissions|biomax_punch/i.test(s)));
  });

  it("the down drops exactly that table", () => {
    assert.deepEqual(down, ["DROP TABLE IF EXISTS `attendance_recalculation_run`"]);
  });
});
