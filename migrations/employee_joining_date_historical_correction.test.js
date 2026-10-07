/**
 * The historical joining-date correction key - declared, granted to nobody.
 *
 *   node --test migrations/employee_joining_date_historical_correction.test.js
 *
 * No database: the structural claims are read from the SQL, the same way the
 * other permission migrations in this directory are tested.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const NAME = "20261113120000-employee-joining-date-historical-correction";
const dir = path.join(__dirname, "mysql/migrations");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));
const KEY = "employee_joining_date_historical_correction";

describe("the migration", () => {
  it("is unique, sorts after every migration that existed when it was written, and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
    assert.deepEqual(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)), [NAME]);
    // The only migrations after it are the ones added since, named here so a
    // new one is a deliberate addition (the convention of
    // attendance_device_time_correction.test.js).
    const LATER = [
      "20261120120000-epfo-wage-ceiling-2026",
      "20261121120000-company-details-permission",
      "20261122120000-payroll-export-payslips-permission",
      "20261123120000-payroll-reports",
      "20261124120000-employee-payroll-eligible",
    ];
    assert.deepEqual(all.filter((f) => f > NAME).sort(), LATER);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("declares the key the routes check", () => {
    assert.equal(P.EMPLOYEE_JOINING_DATE_HISTORICAL_CORRECTION, KEY);
    assert.match(up, new RegExp(`INSERT INTO \`all_permissions\`[\\s\\S]*'${KEY}'`));
  });

  it("is idempotent", () => {
    assert.match(up, /WHERE NOT EXISTS/);
  });

  it("grants it to NOBODY - administrators only, through the user_type 2 bypass", () => {
    assert.ok(!/INSERT INTO `permissions`/.test(up), "no designation is granted the key on deploy");
  });

  it("changes no table and touches no employee", () => {
    assert.ok(!/\b(ALTER|CREATE|DROP|UPDATE)\b/i.test(up));
    assert.ok(!/new_employee|employee_employment_period|employee_lifecycle_event/.test(up));
  });

  it("down removes the key and any grant of it, and nothing else", () => {
    const deletes = [...down.matchAll(/DELETE FROM `([a-z_]+)` WHERE `permission_key` = '([a-z_]+)'/g)];
    assert.deepEqual(deletes.map((m) => [m[1], m[2]]), [
      ["permissions", KEY],
      ["all_permissions", KEY],
    ]);
  });
});
