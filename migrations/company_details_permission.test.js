/**
 * Master → Company Details: the permission key - declared, granted to nobody,
 * and NO change to `company_details` (its `status` is "Active for Payslip").
 *
 *   node --test migrations/company_details_permission.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const NAME = "20261121120000-company-details-permission";
const dir = path.join(__dirname, "mysql/migrations");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));
const KEY = "manage_company_details";

describe("the company details permission migration", () => {
  it("is unique, sorts after every migration that existed when it was written, and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
    // The only migrations after it are the ones added since, named here so a
    // new one is a deliberate addition (the convention of
    // attendance_device_time_correction.test.js).
    assert.deepEqual(all.filter((f) => f > NAME).sort(), ["20261122120000-payroll-export-payslips-permission", "20261123120000-payroll-reports", "20261124120000-employee-payroll-eligible", "20261125120000-attendance-ot-auto-pending", "20261126120000-attendance-ot-late-settlement", "20261127120000-attendance-ot-correction-priority", "20261128120000-attendance-ot-historical-review"]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("declares the key the routes check, idempotently", () => {
    assert.equal(P.MANAGE_COMPANY_DETAILS, KEY);
    assert.match(up, new RegExp(`INSERT INTO \`all_permissions\`[\\s\\S]*'${KEY}'`));
    assert.match(up, /WHERE NOT EXISTS/);
  });

  it("grants it to NOBODY and changes no table - company_details is reused as it is", () => {
    assert.ok(!/INSERT INTO `permissions`/.test(up));
    assert.ok(!/\b(ALTER|CREATE|DROP|UPDATE|DELETE)\b/i.test(up));
    assert.ok(!/company_details/.test(up.replace(/manage_company_details/g, "")));
  });

  it("down removes the key and any grant of it, and nothing else", () => {
    const deletes = [...down.matchAll(/DELETE FROM `([a-z_]+)` WHERE `permission_key` = '([a-z_]+)'/g)];
    assert.deepEqual(deletes.map((m) => [m[1], m[2]]), [
      ["permissions", KEY],
      ["all_permissions", KEY],
    ]);
    assert.ok(!/company_details/.test(down.replace(/manage_company_details/g, "")));
  });
});
