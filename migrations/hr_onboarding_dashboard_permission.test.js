/**
 * The HR Onboarding dashboard permission migration declares ONE key, grants
 * it to one named designation, and touches nothing else.
 *
 *   node --test migrations/hr_onboarding_dashboard_permission.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `work_shift_permissions.test.js` and `hr_permission_keys_b2.test.js` prove
 * theirs.
 *
 * WHAT MATTERS MOST HERE IS WHAT IT MUST NOT DO. This key exists to be
 * SEPARATE from `employee_scope_all_branches`: the screen and the employee
 * reach are two decisions, and the whole point of the change is that granting
 * company-wide employee access to some future designation must not hand them
 * HR's work queue as a side effect. So the migration must not derive its
 * grants from that key, must not grant it, and must not revoke it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261003120000-hr-onboarding-dashboard-permission";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const KEY = P.VIEW_HR_ONBOARDING_DASHBOARD;

describe("the key itself", () => {
  it("is its own key, and not the branch-scope one", () => {
    assert.equal(KEY, "view_hr_onboarding_dashboard");
    assert.notEqual(KEY, P.EMPLOYEE_SCOPE_ALL_BRANCHES);
    assert.notEqual(KEY, P.VIEW_EMPLOYEE_SENSITIVE);
    assert.notEqual(KEY, P.VIEW_EMPLOYEES);
  });
});

describe("up", () => {
  const sql = read(`${NAME}-up.sql`);
  const stmts = statements(sql);
  const declarations = stmts.filter((s) => /^INSERT INTO `all_permissions`/.test(s));
  const grants = stmts.filter((s) => /^INSERT INTO `permissions`/.test(s));

  it("is inserts only - no table, column or employee row is touched", () => {
    for (const stmt of stmts) {
      assert.match(stmt, /^INSERT INTO/, `unexpected statement: ${stmt}`);
    }
    assert.equal(stmts.length, declarations.length + grants.length);
    // Additive, and nothing destructive anywhere in the file.
    for (const forbidden of ["DELETE", "UPDATE", "DROP", "ALTER", "TRUNCATE", "REPLACE"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`).test(stripComments(sql)),
        `${forbidden} must not appear in an additive migration`
      );
    }
  });

  it("declares exactly one key, guarded so a re-run adds nothing", () => {
    assert.equal(declarations.length, 1);
    assert.match(declarations[0], new RegExp(`SELECT '${KEY}' FROM DUAL`));
    assert.match(
      declarations[0],
      new RegExp(`WHERE NOT EXISTS \\(SELECT 1 FROM \`all_permissions\` WHERE \`permission_key\` = '${KEY}'\\)`)
    );
  });

  it("grants it to HR EXECUTIVE, and to nobody else", () => {
    assert.equal(grants.length, 1);
    assert.match(grants[0], new RegExp(`SELECT '${KEY}' AS \`permission_key\``));
    assert.match(grants[0], /UPPER\(TRIM\(`designation_name`\)\) = 'HR EXECUTIVE'/);
    // One designation named, and it is not chosen by any other key's holders.
    assert.equal((grants[0].match(/designation_name/g) || []).length, 1);
  });

  it("re-running adds no duplicate grant", () => {
    assert.match(
      grants[0],
      /WHERE NOT EXISTS \( SELECT 1 FROM `permissions` p WHERE p\.`permission_key` = k\.`permission_key` AND p\.`designation_id` = d\.`designation_id` \)/
    );
  });

  it("DOES NOT DERIVE ITS GRANTS FROM THE BRANCH-SCOPE KEY, OR ANY OTHER KEY", () => {
    // The defect this whole change exists to prevent: if the grant were
    // selected from the holders of `employee_scope_all_branches`, the two
    // permissions would be welded together again and every future holder of
    // company-wide employee access would silently receive the work queue.
    const body = stripComments(sql);
    assert.ok(
      !body.includes(P.EMPLOYEE_SCOPE_ALL_BRANCHES),
      "the branch-scope key must not appear in this migration at all"
    );
    assert.ok(!body.includes(P.VIEW_EMPLOYEE_SENSITIVE));
    assert.ok(!body.includes(P.VIEW_EMPLOYEES));
    // The only key named anywhere is this one.
    const keysNamed = new Set(body.match(/'[a-z_]{6,}'/g) || []);
    keysNamed.delete("'HR EXECUTIVE'");
    assert.deepEqual([...keysNamed], [`'${KEY}'`], "exactly one permission key is named");
  });

  it("GRANTS NO EMPLOYEE REACH - it opens a screen and nothing else", () => {
    // It writes to `permissions` only. No branch table, no employee row, no
    // scope resolution: a holder still sees whatever their branch scope
    // allows, which is the independence this key was created for.
    const body = stripComments(sql);
    for (const table of ["employee_branch", "new_employee", "store", "outlets"]) {
      assert.ok(!body.includes(table), `${table} must not be touched`);
    }
  });
});

describe("down", () => {
  const sql = read(`${NAME}-down.sql`);
  const stmts = statements(sql);

  it("removes the grant and the declaration, and nothing else", () => {
    assert.equal(stmts.length, 2);
    for (const stmt of stmts) {
      assert.match(stmt, /^DELETE FROM/);
      assert.ok(stmt.includes(KEY), "every delete names this key");
    }
  });

  it("LEAVES `employee_scope_all_branches` ALONE - HR keeps its reach", () => {
    // Rolling the screen back must not also revoke HR's company-wide employee
    // scope: that is a separate decision, granted by a separate migration.
    assert.ok(!stripComments(sql).includes(P.EMPLOYEE_SCOPE_ALL_BRANCHES));
  });
});

describe("ordering", () => {
  it("sorts after every migration that exists today, with no collision", () => {
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.slice(0, 14))
      .filter((id) => /^\d{14}$/.test(id));
    const mine = NAME.slice(0, 14);
    const others = all.filter((id) => id !== mine);
    assert.equal(all.filter((id) => id === mine).length, 1, "the identifier is unique");
    for (const id of others) {
      assert.ok(id < mine, `${id} must sort before ${mine}`);
    }
  });
});
