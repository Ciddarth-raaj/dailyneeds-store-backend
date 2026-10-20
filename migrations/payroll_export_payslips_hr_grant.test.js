/**
 * Payroll -> Download Payslips: HR (and only HR) is granted the export key.
 *
 *   node --test migrations/payroll_export_payslips_hr_grant.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20261210120000-payroll-export-payslips-hr-grant";
const dir = path.join(__dirname, "mysql/migrations");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));

describe("the HR payroll export payslips grant", () => {
  it("is unique and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("grants payroll_export_payslips to HR EXECUTIVE only, idempotently, and changes no table", () => {
    assert.equal((up.match(/INSERT INTO/g) || []).length, 1);
    assert.match(up, /INSERT INTO `permissions`[\s\S]*'payroll_export_payslips'/);
    assert.match(up, /UPPER\(TRIM\(d\.`designation_name`\)\) = 'HR EXECUTIVE'/);
    assert.ok(!/ACCOUNT/i.test(up), "Accounts is not granted");
    assert.match(up, /NOT EXISTS/);
    assert.ok(!/\b(ALTER|CREATE|DROP|UPDATE|DELETE)\b/i.test(up));
  });

  it("down removes HR's grant only", () => {
    const statements = down.split(";").map((x) => x.trim()).filter(Boolean);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^DELETE p FROM `permissions` p/);
    assert.match(statements[0], /'payroll_export_payslips'/);
    assert.match(statements[0], /'HR EXECUTIVE'/);
    assert.ok(!/all_permissions/.test(down));
  });
});
