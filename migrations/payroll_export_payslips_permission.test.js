/**
 * Payroll -> Download Payslips: the bulk-export permission key - declared,
 * granted to nobody, and no table change.
 *
 *   node --test migrations/payroll_export_payslips_permission.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const NAME = "20261122120000-payroll-export-payslips-permission";
const dir = path.join(__dirname, "mysql/migrations");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));
const KEY = "payroll_export_payslips";

describe("the payroll export payslips permission migration", () => {
  it("is unique, only deliberately-named migrations follow it, and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
    // Migrations added since, named so a new one is a deliberate addition
    // (the convention of attendance_device_time_correction.test.js).
    assert.deepEqual(all.filter((f) => f > NAME).sort(), ["20261123120000-payroll-reports", "20261124120000-employee-payroll-eligible", "20261125120000-attendance-ot-auto-pending", "20261126120000-attendance-ot-late-settlement", "20261127120000-attendance-ot-correction-priority", "20261129120000-lr-followup-manual"]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("declares the key the export routes check, idempotently", () => {
    assert.equal(P.PAYROLL_EXPORT_PAYSLIPS, KEY);
    assert.match(up, new RegExp(`INSERT INTO \`all_permissions\`[\\s\\S]*'${KEY}'`));
    assert.match(up, /WHERE NOT EXISTS/);
  });

  it("grants it to NOBODY and changes no table", () => {
    assert.ok(!/INSERT INTO `permissions`/.test(up), "no designation is granted it");
    assert.ok(!/\b(ALTER|CREATE|DROP|UPDATE|DELETE)\b/i.test(up));
    assert.equal((up.match(/INSERT INTO/g) || []).length, 1);
  });

  it("down removes the key and any grant of it, and nothing else", () => {
    const statements = down.split(";").map((x) => x.trim()).filter(Boolean);
    assert.deepEqual(statements, [
      "DELETE FROM `permissions` WHERE `permission_key` = 'payroll_export_payslips'",
      "DELETE FROM `all_permissions` WHERE `permission_key` = 'payroll_export_payslips'",
    ]);
  });

  it("both export routes require it on top of the View Payslip keys; the single payslip read does not", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "payrun_calculation.js"), "utf8");
    const gate = (p) => {
      const at = routes.indexOf(`"${p}",`);
      return routes.slice(at, routes.indexOf("async (req, res)", at));
    };
    const ALL4 = "requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.PAYROLL_EXPORT_PAYSLIPS)";
    assert.ok(gate("/payrun/calculation/payslips/export/plan").includes(ALL4));
    assert.ok(gate("/payrun/calculation/payslips/export").includes(ALL4));
    assert.ok(!gate("/payrun/calculation/payslip").includes("PAYROLL_EXPORT_PAYSLIPS"), "View Payslip is unchanged");
  });
});
