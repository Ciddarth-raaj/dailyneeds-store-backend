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
 *   it must not backfill a reason nobody gave, or an amendment nobody made
 *   it must not make a column NOT NULL, which would be wrong for every
 *     opening salary and for every row that already exists
 *   it must not declare or grant a permission - M2 declared all five M4 keys
 *   it must not touch the legacy employee-master salary column
 *
 * AND THE ONE THING THAT IS NOT A TEXT ASSERTION. The one-pending-proposal
 * unique key cannot be applied to a database that already holds two undecided
 * proposals for one employee. The runner beside the SQL refuses that case with
 * a readable message and changes nothing, rather than picking one of somebody's
 * two pay proposals to discard - proved here against a fake connection.
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

  it("ADDS FOUR COLUMNS AND ONE UNIQUE KEY, AND NOTHING ELSE", () => {
    // The reason, the two amendment-audit columns, and the generated marker
    // that carries the one-pending-proposal guard. Not a schema redesign.
    assert.match(body, /ADD COLUMN `revision_reason` VARCHAR\(500\) NULL DEFAULT NULL/);
    assert.match(body, /ADD COLUMN `changed_by` INT NULL DEFAULT NULL/);
    assert.match(body, /ADD COLUMN `changed_at` TIMESTAMP NULL DEFAULT NULL/);
    assert.match(body, /ADD COLUMN `pending_proposal_marker` TINYINT GENERATED ALWAYS AS/);
    const alters = body.match(/ADD COLUMN/gi) || [];
    assert.equal(alters.length, 4, "four columns, not a schema redesign");
    assert.ok(!/CREATE TABLE/i.test(body), "M4 adds no table");
    assert.ok(!/DROP COLUMN|DROP INDEX/i.test(body), "and drops nothing");

    const keys = body.match(/ADD UNIQUE KEY/gi) || [];
    assert.equal(keys.length, 1, "exactly one new constraint");
    assert.ok(!/ADD KEY|CREATE INDEX/i.test(body), "and no other index");
  });

  it("THE PENDING GUARD IS A UNIQUE KEY ON A GENERATED MARKER", () => {
    // The same trick M2's `active_effective_from` already uses on this table:
    // a generated column that is NULL for the rows the constraint must NOT
    // apply to, because MySQL treats NULLs in a unique index as distinct. So
    // one PENDING row per employee, and any number of decided ones.
    assert.match(
      body,
      /GENERATED ALWAYS AS \(CASE WHEN `status` = ''PENDING'' THEN 1 ELSE NULL END\) STORED/,
      "1 only while PENDING, NULL once decided"
    );
    assert.match(
      body,
      /ADD UNIQUE KEY `uq_salary_pending_proposal` \(`employee_id`, `pending_proposal_marker`\)/
    );
  });

  it("REJECTED AND APPROVED ROWS YIELD NULL, so history is never constrained", () => {
    // A rejected proposal must never block a new one, and an employee's
    // approved history is permanent and arbitrarily long. Both follow from the
    // marker being NULL for anything that is not PENDING - which is what the
    // ELSE branch says, and there is no other branch.
    const marker = body.match(/CASE WHEN `status` = ''PENDING'' THEN 1 ELSE NULL END/);
    assert.ok(marker, "one branch for PENDING, one NULL branch for everything else");
    assert.ok(
      !/WHEN `status` = ''REJECTED''/.test(body),
      "no status is named individually - anything not PENDING is simply unconstrained"
    );
  });

  it("the amendment audit is its own two columns, NOT `updated_at`", () => {
    // `updated_at` is ON UPDATE CURRENT_TIMESTAMP, so it moves on approval and
    // on rejection too. Reading it as an amendment time would report an
    // amendment for every approved revision that never had one.
    assert.match(body, /`changed_by`/);
    assert.match(body, /`changed_at`/);
    assert.ok(!/`updated_at`/.test(body), "the generic timestamp is left exactly as it is");
    assert.ok(!/ON UPDATE/i.test(body), "and the new column does not get its behaviour");
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
    // Every row predating these columns was created without them. Filling one
    // in would be the migration asserting a justification for a pay decision -
    // or an amendment - it did not witness, which is the same mistake M2
    // refused to make with `previous_eps_member`.
    // Backticked, so the guard variable `@add_revision_reason` - which is an
    // assignment to a session variable and not to the column - is not mistaken
    // for one. An assignment INTO the column would be a SET clause.
    for (const column of ["revision_reason", "changed_by", "changed_at"]) {
      const assigned = new RegExp("`" + column + "`\\s*=", "i");
      assert.ok(!assigned.test(body), `nothing is assigned into ${column}`);
    }
    assert.ok(!/\bDEFAULT\s+'/i.test(body), "and there is no string default");
    assert.match(body, /NULL DEFAULT NULL/);
    assert.ok(!/NOT NULL/i.test(body), "NOT NULL would be wrong for every opening salary");
  });

  it("NEVER RESOLVES A DUPLICATE-PENDING CLASH BY CHANGING DATA", () => {
    // If two undecided proposals already exist for one employee, the unique
    // key cannot be created - and the correct outcome is that the migration
    // FAILS. Rejecting, deleting or merging one of them would be a migration
    // deciding somebody's pay.
    assert.ok(!/\bDELETE\b/i.test(body));
    assert.ok(!/\bUPDATE\b/i.test(body));
    assert.ok(!/\bINSERT\b/i.test(body));
    assert.ok(!/IGNORE/i.test(body), "no ALTER IGNORE, which would silently drop rows");
    assert.ok(!/ON DUPLICATE KEY/i.test(body));
  });

  it("does not touch the legacy employee-master salary column", () => {
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

  it("IS RE-RUNNABLE — every column and the key are added only when absent", () => {
    // MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration that cannot be
    // re-run is one that cannot be recovered halfway through.
    assert.match(body, /information_schema/i);
    for (const column of [
      "revision_reason",
      "changed_by",
      "changed_at",
      "pending_proposal_marker",
    ]) {
      assert.ok(
        body.includes(`COLUMN_NAME\` = '${column}'`),
        `${column} is guarded on its own absence`
      );
    }
    // The index is guarded against STATISTICS rather than COLUMNS - a column
    // check would not tell you whether the key had been created.
    assert.match(body, /STATISTICS/);
    assert.match(body, /INDEX_NAME` = 'uq_salary_pending_proposal'/);

    // Five guarded statements, each prepared, executed and deallocated.
    assert.equal((body.match(/=\s*0,/g) || []).length, 5, "each guarded on absence");
    assert.equal((body.match(/'DO 0'/g) || []).length, 5, "and each a no-op when present");
    assert.equal(stmts.filter((s) => /^PREPARE/i.test(s)).length, 5);
    assert.equal(stmts.filter((s) => /^EXECUTE/i.test(s)).length, 5);
    assert.equal(stmts.filter((s) => /^DEALLOCATE PREPARE/i.test(s)).length, 5);
  });

  it("APPLIES CLEANLY TO A PRODUCTION DATABASE SITTING AT M2", () => {
    // M4 is not deployed, so this file was edited rather than chased with a
    // second migration. That is only safe while it stays additive and
    // guarded - it alters the table M2 created and assumes nothing else.
    assert.ok(!/`employee_salary`\s*\(/.test(body), "it does not recreate the table");
    const altered = [...body.matchAll(/ALTER TABLE `(\w+)`/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(altered)], ["employee_salary"], "one table, M2's");
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

  it("drops only what this migration added", () => {
    for (const column of [
      "revision_reason",
      "changed_by",
      "changed_at",
      "pending_proposal_marker",
    ]) {
      assert.ok(body.includes(`DROP COLUMN \`${column}\``), `${column} is reversed`);
    }
    const drops = body.match(/DROP COLUMN/gi) || [];
    assert.equal(drops.length, 4, "four columns, and no others");
    assert.match(body, /DROP INDEX `uq_salary_pending_proposal`/);
    assert.equal((body.match(/DROP INDEX/gi) || []).length, 1, "M2's indexes survive");
    assert.ok(!/DROP TABLE/i.test(body), "the salary history survives a rollback");
  });

  it("DROPS THE KEY BEFORE THE COLUMN IT IS BUILT ON", () => {
    // A generated column cannot be dropped while an index depends on it, so
    // the order is not a style choice - the reverse order fails.
    assert.ok(
      body.indexOf("DROP INDEX `uq_salary_pending_proposal`") <
        body.indexOf("DROP COLUMN `pending_proposal_marker`"),
      "the index goes first"
    );
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
    assert.equal((body.match(/=\s*1,/g) || []).length, 5, "one guard per reversal");
    assert.equal((body.match(/'DO 0'/g) || []).length, 5);
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

  it("CHECKS FOR DUPLICATE PENDING PROPOSALS BEFORE IT RUNS ANY DDL", async () => {
    // The refusal must happen before a single statement of the up file runs,
    // so a database that cannot take the guard is left exactly as it was.
    const runner = require(path.join(__dirname, "mysql/migrations", `${NAME}.js`));
    const queries = [];
    const db = {
      runSql(sql) {
        queries.push(sql.replace(/\s+/g, " ").trim());
        if (/information_schema/i.test(sql)) return Promise.resolve([{ found: 1 }]);
        return Promise.resolve([
          { employee_id: 41, pending_count: 2 },
          { employee_id: 77, pending_count: 3 },
        ]);
      },
    };

    await assert.rejects(
      () => runner._refuseDuplicatePendingProposals(db),
      (err) => {
        // It NAMES them, because "duplicate key" is not something anybody can
        // act on and "employee 41 has 2 pending proposals" is.
        assert.match(err.message, /employee 41 has 2 pending proposals/);
        assert.match(err.message, /employee 77 has 3 pending proposals/);
        assert.match(err.message, /Nothing has been changed/);
        return true;
      }
    );

    // It READ, and it wrote nothing.
    assert.ok(queries.every((q) => /^SELECT/i.test(q)), "the check is two reads");
    assert.ok(!queries.some((q) => /\b(UPDATE|DELETE|INSERT|ALTER|DROP)\b/i.test(q)));
  });

  it("DOES NOT PICK A WINNER — it refuses and leaves the data alone", () => {
    const runner = fs.readFileSync(
      path.join(__dirname, "mysql/migrations", `${NAME}.js`),
      "utf8"
    );
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\bDELETE\b/i.test(code), "it deletes no proposal");
    assert.ok(!/\bUPDATE\b/i.test(code), "and rejects none on somebody's behalf");
    assert.ok(!/REJECTED/.test(code), "choosing between two pay proposals is a person's job");
  });

  it("lets a clean database through", async () => {
    const runner = require(path.join(__dirname, "mysql/migrations", `${NAME}.js`));
    const db = {
      runSql(sql) {
        if (/information_schema/i.test(sql)) return Promise.resolve([{ found: 1 }]);
        return Promise.resolve([]);
      },
    };
    assert.equal(await runner._refuseDuplicatePendingProposals(db), null);
  });

  it("is harmless on a database that has not reached M2 yet", async () => {
    // The table does not exist, so there is nothing to check and nothing to
    // fail on - the guard must not turn a fresh install into an error.
    const runner = require(path.join(__dirname, "mysql/migrations", `${NAME}.js`));
    const seen = [];
    const db = {
      runSql(sql) {
        seen.push(sql);
        return Promise.resolve([{ found: 0 }]);
      },
    };
    assert.equal(await runner._refuseDuplicatePendingProposals(db), null);
    assert.equal(seen.length, 1, "it stops after finding no table");
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
