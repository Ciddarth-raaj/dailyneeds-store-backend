/**
 * Migration 20261201120000-fnf-settlement - static checks.
 *
 *   node --test migrations/fnf_settlement.test.js
 *
 * The SQL itself is executed (up twice, down, up) against MySQL in
 * repository/employee_exit.mysql.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const P = require("../constants/hr_permissions");

const NAME = "20261201120000-fnf-settlement";
const dir = path.join(__dirname, "mysql/migrations");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));
const KEYS = [
  P.VIEW_FNF_SETTLEMENT,
  P.CONFIRM_FNF_PAYMENT,
  P.VIEW_EXIT_INTERVIEW,
  P.MANAGE_EXIT_INTERVIEW,
  P.OVERRIDE_REHIRE_ELIGIBILITY,
  P.APPROVE_REHIRE_EXCEPTION,
];

describe("the F&F settlement migration", () => {
  it("is unique, is followed only by the migrations named here, and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
    assert.deepEqual(all.filter((f) => f > NAME), ["20261203120000-outlet-retailpilot-id", "20261204120000-purchase-retailpilot-columns"]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("declares every key the routes check, idempotently, and grants them to NOBODY", () => {
    assert.deepEqual(KEYS, [
      "view_fnf_settlement", "confirm_fnf_payment", "view_exit_interview", "manage_exit_interview", "override_rehire_eligibility",
      "approve_rehire_exception",
    ]);
    KEYS.forEach((k) => {
      assert.match(up, new RegExp(`INSERT INTO \`all_permissions\`[\\s\\S]*?'${k}'[\\s\\S]*?WHERE NOT EXISTS`));
    });
    assert.ok(!/INSERT INTO `permissions`/.test(up));
  });

  it("is additive: no UPDATE, no DELETE and no DROP on an existing table; every ALTER is guarded", () => {
    // As STATEMENTS (an `ON UPDATE CURRENT_TIMESTAMP` column default is not one).
    assert.ok(!/(^|;)\s*UPDATE\s/im.test(up));
    assert.ok(!/(^|;)\s*DELETE\s/im.test(up));
    assert.ok(!/\bDROP\s+(TABLE|COLUMN)/i.test(up));
    const alters = up.match(/'ALTER TABLE[^']*/g) || [];
    // ONE column, on payrun_payslip: which document a published snapshot is.
    assert.equal(alters.length, 1);
    assert.equal((up.match(/information_schema`\.`COLUMNS`/g) || []).length, 1);
    assert.match(up, /`document_type` ENUM\(''PAYSLIP'',''FNF''\) NOT NULL DEFAULT ''PAYSLIP''/);
  });

  it("adds NO F&F earning / recovery field: no leave encashment, gratuity, notice pay or recovery anywhere", () => {
    for (const word of ["fnf_items", "fnf_additions", "fnf_deductions", "payrun_fnf_item", "GRATUITY", "LEAVE_ENCASHMENT", "NOTICE_PAY", "NOTICE_PERIOD_RECOVERY"]) {
      assert.ok(!up.includes(word), word);
      assert.ok(!down.includes(word), word);
    }
    assert.ok(!/ALTER TABLE `payrun_calculation`/.test(up), "the calculation table is untouched");
    // F&F references the published payroll document; it stores no amount of its own.
    for (const col of ["settled_net_amount", "net_amount", "net_pay", "amount"]) {
      assert.ok(!new RegExp("`" + col + "`").test(up), col);
    }
  });

  it("the database enforces one case per exit and one payroll month per settlement", () => {
    assert.match(up, /UNIQUE KEY `uq_fnf_exit` \(`employee_id`, `exit_date`\)/);
    assert.match(up, /UNIQUE KEY `uq_fnf_payrun` \(`payrun_employee_id`\)/);
    assert.match(up, /UNIQUE KEY `uq_exit_interview_case` \(`fnf_settlement_id`\)/);
  });

  it("down removes exactly what up added", () => {
    for (const t of ["employee_rehire_exception", "payrun_exit_reconcile_audit", "employee_rehire_assessment", "employee_exit_interview", "employee_fnf_settlement_event",
      "employee_fnf_settlement"]) {
      assert.match(down, new RegExp(`DROP TABLE IF EXISTS \`${t}\``));
    }
    assert.match(down, /DROP COLUMN `document_type`/);
    KEYS.forEach((k) => assert.ok(down.includes(`'${k}'`), k));
  });
});
