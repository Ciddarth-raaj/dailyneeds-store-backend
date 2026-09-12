/**
 * The M4 salary-revision migration is additive, re-runnable, and asserts
 * nothing about anybody's pay.
 *
 *   node --test migrations/m4_salary_revision_approval.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `m2_salary_engine.test.js` proves the migration it builds on. That suits
 * what matters most about this one, which is what it must NOT do:
 *
 *   it must not write, rewrite or delete a single salary row
 *   it must not backfill a reason nobody gave
 *   it must not make the column NOT NULL, which would be wrong for every
 *     opening salary and for every row that already exists
 *   it must not declare or grant a permission - M2 declared all five M4 keys
 *   it must not touch the legacy `new_employee.salary`
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260916120000-m4-salary-revision-approval";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

describe("up", () => {
  const sql = read(`${NAME}-up.sql`);
  const body = stripComments(sql);
  const stmts = statements(sql);

  it("ADDS EXACTLY ONE COLUMN AND DOES NOTHING ELSE", () => {
    assert.match(body, /ADD COLUMN `revision_reason` VARCHAR\(500\) NULL DEFAULT NULL/);
    const alters = body.match(/ADD COLUMN/gi) || [];
    assert.equal(alters.length, 1, "one column, not a schema redesign");
    assert.ok(!/CREATE TABLE/i.test(body), "M4 adds no table");
    assert.ok(!/CREATE INDEX|ADD KEY|ADD UNIQUE/i.test(body), "and no index");
  });

  it("NEVER WRITES, REWRITES OR DELETES A SALARY ROW", () => {
    // The rule this file exists to keep. The table it alters is a permanent
    // audit record of what people have been paid and who agreed to it.
    assert.ok(!/\bINSERT\s+INTO\b/i.test(body), "not one row is written");
    assert.ok(!/\bUPDATE\s+/i.test(body), "and not one is rewritten");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(body), "and none is removed");
    assert.ok(!/\bTRUNCATE\b/i.test(body));
    assert.ok(!/\bDROP\s+TABLE\b/i.test(body));
  });

  it("BACKFILLS NOTHING — a reason nobody gave is NULL, not a sentence", () => {
    // Every row predating this column was created without the field. Filling
    // it in would be the migration asserting a justification for a pay
    // decision it did not witness, which is the same mistake M2 refused to
    // make with `previous_eps_member`.
    // Backticked, so the guard variable `@add_revision_reason` - which is an
    // assignment to a session variable and not to the column - is not mistaken
    // for one. An assignment INTO the column would be a SET clause.
    assert.ok(!/`revision_reason`\s*=/i.test(body), "nothing is assigned into the column");
    assert.ok(!/\bDEFAULT\s+'/i.test(body), "and there is no string default");
    assert.match(body, /NULL DEFAULT NULL/);
    assert.ok(!/NOT NULL/i.test(body), "NOT NULL would be wrong for every opening salary");
  });

  it("does not touch the legacy `new_employee.salary`", () => {
    assert.ok(!/\bnew_employee\b/i.test(body), "the employee master is not read or written");
  });

  it("DECLARES AND GRANTS NO PERMISSION", () => {
    // M2 declared all five M4 rights (`view_salary`, `add_salary`,
    // `edit_salary`, `manual_salary_component_override`,
    // `approve_salary_revision`) and granted them to nobody. M4 builds their
    // screens; it does not hand anyone the keys.
    assert.ok(!/all_permissions/i.test(body));
    assert.ok(!/\bpermissions\b/i.test(body));
    for (const key of [
      "view_salary",
      "add_salary",
      "edit_salary",
      "manual_salary_component_override",
      "approve_salary_revision",
    ]) {
      assert.ok(!body.includes(key), `${key} must not be granted by a migration`);
    }
  });

  it("IS RE-RUNNABLE — the column is only added when it is absent", () => {
    // MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration that cannot be
    // re-run is one that cannot be recovered halfway through.
    assert.match(body, /information_schema/i);
    assert.match(body, /COLUMN_NAME` = 'revision_reason'/);
    assert.match(body, /=\s*0,/, "guarded on the column not already existing");
    assert.match(body, /'DO 0'/, "and does nothing when it does");
    assert.ok(stmts.some((s) => /^PREPARE/i.test(s)));
    assert.ok(stmts.some((s) => /^EXECUTE/i.test(s)));
    assert.ok(stmts.some((s) => /^DEALLOCATE PREPARE/i.test(s)));
  });

  it("matches the length of the two reason columns already on the row", () => {
    // `override_reason` and `rejection_reason` are both VARCHAR(500); three
    // reason fields on one row with three different limits is a trap.
    assert.match(body, /VARCHAR\(500\)/);
  });
});

describe("down", () => {
  const sql = read(`${NAME}-down.sql`);
  const body = stripComments(sql);

  it("drops only the column this migration added", () => {
    assert.match(body, /DROP COLUMN `revision_reason`/);
    const drops = body.match(/DROP COLUMN/gi) || [];
    assert.equal(drops.length, 1);
    assert.ok(!/DROP TABLE/i.test(body), "the salary history survives a rollback");
  });

  it("REMOVES NO SALARY RECORD AND REWINDS NO DECISION", () => {
    assert.ok(!/\bDELETE\s+FROM\b/i.test(body));
    assert.ok(!/\bUPDATE\s+/i.test(body));
    assert.ok(!/\bTRUNCATE\b/i.test(body));
    assert.ok(!/status\s*=/i.test(body), "no approval or rejection is undone");
  });

  it("is re-runnable too", () => {
    assert.match(body, /information_schema/i);
    assert.match(body, /=\s*1,/, "guarded on the column actually being there");
    assert.match(body, /'DO 0'/);
  });
});

describe("the runner", () => {
  it("points at this migration's own two files", () => {
    const runner = fs.readFileSync(
      path.join(__dirname, "mysql/migrations", `${NAME}.js`),
      "utf8"
    );
    assert.ok(runner.includes(`${NAME}-up.sql`));
    assert.ok(runner.includes(`${NAME}-down.sql`));
    assert.ok(fs.existsSync(path.join(dir, `${NAME}-up.sql`)));
    assert.ok(fs.existsSync(path.join(dir, `${NAME}-down.sql`)));
  });

  it("sorts after the M2 migration that created the table it alters", () => {
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .sort();
    const m2 = all.indexOf("20260915120000-m2-salary-engine.js");
    const m4 = all.indexOf(`${NAME}.js`);
    assert.ok(m2 !== -1 && m4 !== -1);
    assert.ok(m4 > m2, "the column cannot be added before the table exists");
  });
});
