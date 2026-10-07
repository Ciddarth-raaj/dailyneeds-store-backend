/**
 * Prior-Month OT carry-forward migration: two NEW tables, two guarded NULLable
 * columns on the payroll calculation table, nothing existing rewritten.
 *
 *   node --test migrations/attendance_ot_late_settlement.test.js
 *
 * Run against real SQL in repository/prior_month_ot_carry_forward.mysql.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const NAME = "20261125120000-attendance-ot-late-settlement";
const strip = (sql) => sql.replace(/^\s*--.*$/gm, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("one settlement row per OT request, enforced by the database - no OT is settled twice", () => {
    assert.match(up, /UNIQUE KEY `uq_aols_request` \(`attendance_approval_request_id`\)/);
    // ...and tied to it: a request with a settlement cannot be deleted.
    assert.match(up, /CONSTRAINT `fk_aols_request` FOREIGN KEY \(`attendance_approval_request_id`\)\s+REFERENCES `attendance_approval_request` \(`attendance_approval_request_id`\) ON DELETE RESTRICT/);
  });

  it("keeps approval and money apart: its own settlement lifecycle", () => {
    assert.match(up, /`settlement_status` ENUM\('PENDING_SETTLEMENT','INCLUDED','SETTLED','CANCELLED'\)/);
  });

  it("traces the original OT: request, date, month, eligible and approved minutes, the locked calculation, the price", () => {
    ["attendance_approval_request_id", "attendance_date", "source_year", "source_month", "eligible_ot_minutes",
      "approved_ot_minutes", "source_payrun_calculation_id", "source_daily_rate", "nrm_minutes", "ot_hourly_rate",
      "amount", "settlement_year", "settlement_month", "settlement_payrun_calculation_id"].forEach((c) =>
      assert.match(up, new RegExp("`" + c + "`"), c)
    );
  });

  it("adds only two NULLable columns to the payroll calculation, each guarded so a re-run is harmless", () => {
    const adds = [...up.matchAll(/ALTER TABLE `payrun_employee_calculation` ADD COLUMN `([a-z_]+)` [^']*NULL/g)].map((m) => m[1]);
    assert.deepEqual(adds, ["prior_month_ot_amount", "prior_month_ot"]);
    assert.equal((up.match(/information_schema/g) || []).length, 2);
    assert.ok(!/\bUPDATE\s+`?payrun_employee_calculation/i.test(up), "no payroll row is rewritten");
    assert.ok(!/attendance_approval_request`\s+(ADD|MODIFY|DROP)/i.test(up), "the OT record table is not altered");
  });

  it("the down reverses exactly that", () => {
    assert.match(down, /DROP COLUMN `prior_month_ot`/);
    assert.match(down, /DROP COLUMN `prior_month_ot_amount`/);
    assert.match(down, /DROP TABLE IF EXISTS `attendance_ot_late_settlement_log`/);
    assert.match(down, /DROP TABLE IF EXISTS `attendance_ot_late_settlement`;/);
  });
});
