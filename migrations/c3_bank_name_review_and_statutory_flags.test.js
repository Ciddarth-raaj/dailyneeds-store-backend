/**
 * The bank name-review and PF/ESI-applicability migration is additive,
 * re-runnable, and guesses nothing about anybody.
 *
 *   node --test migrations/c3_bank_name_review_and_statutory_flags.test.js
 *
 * Proven against the SQL text - there is no database here - the same way
 * `employee_default_work_shift.test.js` proves its migration. That suits what
 * matters most about this one, which is what it must NOT do: it must not
 * backfill a PF or ESI applicability for the 630 employees nobody has asked
 * about, it must not decide retrospectively which kind of override an old row
 * carried, and it must not leave a rejected account stranded on a status the
 * enum has stopped accepting when it is rolled back.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260910140000-c3-bank-name-review-and-statutory-flags";
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

  it("NEVER BACKFILLS ANYTHING", () => {
    // The one rule this file exists to keep. An UPDATE here would be a
    // migration deciding a statutory fact - who is in the PF scheme - about
    // real people, in the one place it could never be reviewed.
    assert.ok(!/\bUPDATE\b/i.test(body), "no row is written on the way up");
    assert.ok(!/\bINSERT\b/i.test(body), "no row is inserted either");
    assert.ok(!/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i.test(body), "and nothing is removed");
  });

  it("adds REJECTED to the verification status without disturbing the others", () => {
    const modify = stmts.find((s) => /MODIFY COLUMN `status`/.test(s));
    assert.ok(modify, "the enum is widened");
    assert.match(
      modify,
      /ENUM\('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','DUPLICATE_ACCOUNT','REJECTED','FAILED'\) NOT NULL DEFAULT 'NOT_PROVIDED'/
    );
  });

  it("adds the review columns, each guarded so the file can be re-run", () => {
    for (const column of [
      "override_kind",
      "rejected_by_employee_id",
      "rejected_at",
      "rejection_reason",
    ]) {
      assert.match(body, new RegExp(`COLUMN_NAME. = '${column}'`), `${column} is checked for first`);
      assert.match(
        body,
        new RegExp("ADD COLUMN `" + column + "`"),
        `${column} is added`
      );
    }
  });

  it("override_kind can only ever say which of the two checks was waived", () => {
    assert.match(body, /ADD COLUMN `override_kind` ENUM\(''DUPLICATE_ACCOUNT'',''NAME_MISMATCH''\) NULL/);
  });

  it("PF AND ESI APPLICABILITY ARE NULLABLE, WITH NO DEFAULT", () => {
    // NULL means "nobody has said yet", which is a different fact from "not
    // applicable" and has to stay distinguishable from it. A DEFAULT of 0 or
    // 1 would answer for every existing employee at once.
    for (const column of ["pf_applicable", "esi_applicable"]) {
      assert.match(
        body,
        new RegExp("ADD COLUMN `" + column + "` TINYINT\\(1\\) NULL DEFAULT NULL"),
        `${column} defaults to NULL`
      );
    }
  });

  it("touches only the two tables it says it does", () => {
    const tables = new Set((body.match(/ALTER TABLE `(\w+)`/g) || []).map((m) => m.split("`")[1]));
    assert.deepEqual([...tables].sort(), ["employee_bank_verification", "new_employee"]);
  });

  it("leaves the legacy shift columns and every other employee column alone", () => {
    for (const untouched of ["shift_id", "shift_code", "salary", "account_no", "status`"]) {
      assert.ok(
        !new RegExp("`new_employee` MODIFY[^;]*" + untouched).test(body),
        `${untouched} is not modified`
      );
    }
  });
});

describe("down", () => {
  const sql = read(`${NAME}-down.sql`);
  const body = stripComments(sql);
  const stmts = statements(sql);

  it("MOVES REJECTED ROWS OFF THE VALUE BEFORE THE ENUM STOPS ACCEPTING IT", () => {
    // Narrowing an enum under rows that use the value truncates them to ''.
    const update = stmts.findIndex((s) => /^UPDATE `employee_bank_verification`/.test(s));
    const modify = stmts.findIndex((s) => /MODIFY COLUMN `status`/.test(s));
    assert.ok(update >= 0, "the rows are migrated first");
    assert.ok(modify > update, "and only then is the enum narrowed");
    assert.match(stmts[update], /SET `status` = 'NAME_MISMATCH' WHERE `status` = 'REJECTED'/);
  });

  it("sends them back to a status that is still not payroll-ready", () => {
    // NAME_MISMATCH, not FAILED and certainly not VERIFIED: reversing the
    // feature must not let somebody be paid against an account a reviewer had
    // turned down.
    const update = stmts.find((s) => /^UPDATE `employee_bank_verification`/.test(s));
    assert.ok(!/VERIFIED/.test(update));
  });

  it("drops exactly what the up added, each drop guarded", () => {
    const dropped = (body.match(/DROP COLUMN `(\w+)`/g) || []).map((m) => m.split("`")[1]);
    assert.deepEqual(dropped.sort(), [
      "esi_applicable",
      "override_kind",
      "pf_applicable",
      "rejected_at",
      "rejected_by_employee_id",
      "rejection_reason",
    ]);
    for (const column of dropped) {
      assert.match(body, new RegExp(`COLUMN_NAME. = '${column}'`), `${column} is checked for first`);
    }
  });

  it("restores the enum the C2 duplicate guard left behind", () => {
    const modify = stmts.find((s) => /MODIFY COLUMN `status`/.test(s));
    assert.match(
      modify,
      /ENUM\('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','DUPLICATE_ACCOUNT','FAILED'\)/
    );
  });
});
