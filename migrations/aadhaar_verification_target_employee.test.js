/**
 * The target-binding migration: additive, idempotent, reversible, and
 * backfilling nothing.
 *
 *   node --test migrations/aadhaar_verification_target_employee.test.js
 *
 * Proven against the SQL text; there is no database here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261011120000-aadhaar-verification-target-employee";
const COLUMN = "target_employee_id";
const TABLE = "employee_aadhaar_verification";

const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");

describe("up", () => {
  const sql = stripComments(read(`${NAME}-up.sql`));

  it("adds one nullable column and one index, and nothing else", () => {
    assert.match(sql, new RegExp(`ADD COLUMN \`${COLUMN}\` INT NULL`));
    assert.match(sql, new RegExp(`ADD KEY \`idx_aadhaar_verification_target_employee\``));
    const alters = [...sql.matchAll(/ALTER TABLE `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(alters)], [TABLE], "only the verification table is altered");
    const adds = [...sql.matchAll(/ADD COLUMN `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(adds, [COLUMN], "exactly one column is added");
  });

  it("NEVER BACKFILLS, and never touches employee or identity data", () => {
    // A guessed target would bind an old Aadhaar to the wrong person
    // permanently. Historical rows must stay NULL and keep onboarding
    // semantics.
    assert.ok(!/\bUPDATE\b/.test(sql), "no row is rewritten");
    assert.ok(!/\bINSERT\b/.test(sql), "nothing is inserted");
    assert.ok(!/\bDELETE\b/.test(sql), "nothing is deleted");
    assert.ok(!/\bDROP\b/.test(sql), "nothing is dropped");
    assert.ok(!/NOT NULL/.test(sql), "the column must be nullable - NULL is onboarding");
    assert.ok(!/DEFAULT\s+\d/.test(sql), "no default may invent a target");
    for (const table of ["new_employee", "employee_aadhaar_identity", "permissions"]) {
      assert.ok(!sql.includes(`\`${table}\``), `${table} must not be touched`);
    }
  });

  it("does not overload the existing employee_id column", () => {
    // `employee_id` means "this session was CONSUMED by that employee" and is
    // NULL for the whole life of an unconsumed session - which is exactly the
    // window the attack lives in.
    assert.ok(!/MODIFY COLUMN `employee_id`/.test(sql));
    assert.ok(!/CHANGE COLUMN `employee_id`/.test(sql));
  });

  it("adds no foreign key - consistent with the comparable ALTER here", () => {
    // `employee_bank_verification.duplicate_of_employee_id` carries none
    // either; the column is compared, never joined, and a RESTRICT key would
    // newly make deleting an employee fail because of a spent session.
    assert.ok(!/FOREIGN KEY/.test(sql));
    const bankGuard = stripComments(read("20260909120000-c2-bank-duplicate-guard-up.sql"));
    assert.ok(
      /ADD COLUMN `duplicate_of_employee_id` INT NULL/.test(bankGuard) &&
        !/FOREIGN KEY/.test(bankGuard),
      "the precedent this follows must still look like this"
    );
  });

  it("is re-runnable: both statements are guarded on information_schema", () => {
    const guards = [...sql.matchAll(/information_schema/gi)];
    assert.equal(guards.length, 2, "one guard for the column, one for the index");
    assert.match(sql, new RegExp(`'${COLUMN}'`), "the column guard names the column");
    assert.match(sql, /idx_aadhaar_verification_target_employee/);
    // Two prepared statements, each executed and each deallocated.
    assert.equal((sql.match(/PREPARE \w+ FROM/g) || []).length, 2);
    assert.equal((sql.match(/EXECUTE \w+/g) || []).length, 2);
    assert.equal((sql.match(/DEALLOCATE PREPARE/g) || []).length, 2);
  });
});

describe("down", () => {
  const sql = stripComments(read(`${NAME}-down.sql`));

  it("drops exactly what up added, and nothing else", () => {
    assert.match(sql, new RegExp(`DROP COLUMN \`${COLUMN}\``));
    assert.match(sql, /DROP INDEX `idx_aadhaar_verification_target_employee`/);
    const dropped = [...sql.matchAll(/DROP COLUMN `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(dropped, [COLUMN]);
    for (const survivor of ["employee_id", "initiated_by_employee_id", "aadhaar_ciphertext"]) {
      assert.ok(!sql.includes(`DROP COLUMN \`${survivor}\``), `${survivor} must survive`);
    }
    assert.ok(!/\bUPDATE\b|\bDELETE\b|\bINSERT\b/.test(sql), "a rollback rewrites no data");
  });
});

describe("wiring and ordering", () => {
  it("the runner reads its own up and down files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("sorts after every migration that already existed", () => {
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, ""));
    assert.equal(all.filter((f) => f === NAME).length, 1, "the identifier is unique");
    const others = all.filter((f) => f !== NAME).sort();
    assert.ok(NAME > others[others.length - 1], "must be the newest migration");
    // And after the table it alters.
    assert.ok("20260908140000" < NAME.slice(0, 14), "after the C2 Aadhaar tables");
  });

  it("the column it adds is the one the code reads and writes", () => {
    const repo = fs.readFileSync(path.join(__dirname, "../repository/employee_aadhaar.js"), "utf8");
    const usecase = fs.readFileSync(path.join(__dirname, "../usecase/employee_aadhaar.js"), "utf8");
    // Selected by BOTH reads a binding decision rests on.
    const byToken = repo.slice(repo.indexOf("FIND-VERIFICATION-BY-TOKEN"));
    assert.match(byToken.slice(0, 700), new RegExp(COLUMN));
    const locked = repo.slice(repo.indexOf("lockVerificationForUse"));
    assert.match(locked.slice(0, 900), new RegExp(COLUMN));
    assert.match(usecase, new RegExp(`target_employee_id: targetEmployeeId`));
  });
});
