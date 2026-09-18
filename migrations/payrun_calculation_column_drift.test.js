/**
 * The calculation table the APPLICATION reads must be the table the
 * MIGRATIONS build.
 *
 *   node --test migrations/payrun_calculation_column_drift.test.js
 *
 * THE FAILURE THIS FILE EXISTS FOR, in production, in September 2026:
 *
 *   `20261023120000-payrun-calculation-up.sql` had been deployed and recorded
 *   by db-migrate. It was then EDITED IN PLACE to add eight columns to
 *   `payrun_employee_calculation` - `ot_groups` and the seven ESI
 *   contribution-period columns. db-migrate runs a file ONCE, by name, so the
 *   edit never reached the database, while the application shipped reading and
 *   writing all eight. Every `GET /payrun/calculation/month` then died in
 *   MySQL with ER_BAD_FIELD_ERROR "Unknown column 'ot_groups' in 'field
 *   list'", and the review screen showed its generic read failure with every
 *   counter at zero - for every month, whatever anybody's attendance said.
 *
 *   The same edit deleted `attendance_ot_earnings`, which the repository still
 *   reads and still writes. Production has that column (it was created by the
 *   version that actually ran); a database built from the file as it stands
 *   would not.
 *
 * There is no database here, so this proves it the only way text can: it
 * REPLAYS the migrations in the order db-migrate runs them - the CREATE TABLE,
 * then every guarded ADD COLUMN after it - and checks the column list that
 * results against the columns `repository/payrun_calculation.js` actually
 * names. That is the check that was missing: `payrun_calculation.test.js`
 * asserts the migration declares a list of columns written out inside itself,
 * which cannot notice a column the repository needs and nobody listed.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const CREATE = "20261023120000-payrun-calculation-up.sql";
const DRIFT = "20261024120000-payrun-calculation-column-drift-up.sql";

/** Comments may NAME a column to explain it; only statements declare one. */
const statementsOf = (file) =>
  fs.readFileSync(path.join(dir, file), "utf8").replace(/^\s*--.*$/gm, "");

/** The columns `payrun_employee_calculation` has after the migrations run. */
function schemaColumns() {
  const create = statementsOf(CREATE);
  const body = create.match(
    /CREATE TABLE IF NOT EXISTS `payrun_employee_calculation`[\s\S]*?\n\) ENGINE/
  );
  assert.ok(body, "the CREATE TABLE is not where it was");
  const columns = new Set([...body[0].matchAll(/^\s{2}`([a-z_]+)`\s+[A-Z]/gm)].map((m) => m[1]));

  [...statementsOf(DRIFT).matchAll(
    /ALTER TABLE `payrun_employee_calculation` ADD COLUMN `([a-z_]+)`/g
  )].forEach((m) => columns.add(m[1]));

  return columns;
}

/** Every column `repository/payrun_calculation.js` reads from or writes to it. */
function repositoryColumns() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "repository", "payrun_calculation.js"),
    "utf8"
  );
  const used = new Set();

  /* The INSERT contract, taken from the module rather than from its text. */
  const { PayrunCalculationRepository } = require("../repository/payrun_calculation");
  PayrunCalculationRepository.COLUMNS.forEach((c) => used.add(c));

  /* The month's SELECT, which is where the production error was raised. */
  const select = source.match(/LIST-CALCULATIONS[\s\S]*?FROM payrun_employee_calculation/);
  assert.ok(select, "the LIST-CALCULATIONS statement is not where it was");
  select[0]
    /* `DATE_FORMAT(col, ...) AS alias` names the COLUMN, not the alias. */
    .replace(/DATE_FORMAT\(\s*([a-z_]+)\s*,[^)]*\)\s*AS\s*[a-z_]+/g, (m, column) => {
      used.add(column);
      return " ";
    })
    .replace(/^[\s\S]*?`SELECT/, "")
    .replace(/FROM payrun_employee_calculation/, "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z_]+$/.test(s))
    .forEach((s) => used.add(s));

  return used;
}

describe("the deployed calculation table and the code that reads it", () => {
  it("declares every column the repository selects and inserts", () => {
    const schema = schemaColumns();
    const missing = [...repositoryColumns()].filter((c) => !schema.has(c)).sort();
    assert.deepEqual(
      missing,
      [],
      `the repository names columns no migration creates: ${missing.join(", ")}`
    );
  });

  /**
   * THE EIGHT COLUMNS THE PRODUCTION TABLE NEVER GOT, BY NAME. The drift
   * migration is the only thing that puts them on a database that ran the
   * calculation migration before those columns were written into it, so the
   * list is asserted rather than left to a diff nobody re-reads.
   */
  it("adds, in a NEW file, the columns the edit-in-place never delivered", () => {
    const added = [...statementsOf(DRIFT).matchAll(
      /ALTER TABLE `payrun_employee_calculation` ADD COLUMN `([a-z_]+)`/g
    )].map((m) => m[1]);

    for (const column of [
      "attendance_ot_earnings",
      "ot_groups",
      "esi_period_start",
      "esi_period_end",
      "esi_coverage_entry_date",
      "esi_coverage_entry_salary_id",
      "esi_coverage_entry_gross",
      "esi_coverage_basis",
      "esi_contribution_period_continues",
    ]) {
      assert.ok(added.includes(column), `the drift migration does not add ${column}`);
    }
  });

  /**
   * IT IS ADDITIVE AND RE-RUNNABLE, which is what makes it safe to ship to a
   * database that already has some of the columns and not others.
   */
  it("only ever adds a nullable column, guarded, and writes no row", () => {
    const sql = statementsOf(DRIFT);
    assert.ok(!/\bDROP\b/i.test(sql), "nothing is dropped");
    assert.ok(!/\bUPDATE\s/i.test(sql), "no row is written");
    assert.ok(!/\bINSERT\s+INTO\b/i.test(sql), "no row is inserted");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(sql), "no row is deleted");
    assert.ok(!/\bMODIFY\b|\bCHANGE\s+COLUMN\b/i.test(sql), "no column is retyped");

    const adds = sql.match(/ADD COLUMN `[a-z_]+`[^']*/g) || [];
    adds.forEach((add) => assert.match(add, /\bNULL\b/, `${add} is not nullable`));

    const guards = sql.match(/information_schema`?\.`?COLUMNS/gi) || [];
    assert.equal(
      guards.length,
      adds.length,
      "every ADD COLUMN must be guarded on information_schema"
    );

    /* It names one table and no other. */
    const tables = new Set((sql.match(/ALTER TABLE `([a-z_]+)`/g) || []).map((m) => m.slice(13, -1)));
    assert.deepEqual([...tables], ["payrun_employee_calculation"]);
  });

  /**
   * AND THE APPLIED MIGRATION IS NOT EDITED AGAIN.
   *
   * Editing a file db-migrate has already recorded is what caused the outage:
   * the change looks applied in the repository and is absent from every
   * database that ran the file before it. This freezes the column list of
   * `20261023120000-payrun-calculation-up.sql`, so the next person who adds a
   * column there fails this test and writes a new migration instead.
   *
   * The eight names below that production does not have are exactly the ones
   * the drift migration delivers; a database built fresh from this file simply
   * finds them already present and skips them.
   */
  it("freezes the already-applied migration against further edits", () => {
    const body = statementsOf(CREATE).match(
      /CREATE TABLE IF NOT EXISTS `payrun_employee_calculation`[\s\S]*?\n\) ENGINE/
    )[0];
    const declared = [...body.matchAll(/^\s{2}`([a-z_]+)`\s+[A-Z]/gm)].map((m) => m[1]);
    assert.equal(declared.length, 74, "a column was added to or removed from an APPLIED migration");
    assert.equal(declared[0], "payrun_calculation_id");
    assert.equal(declared[declared.length - 1], "updated_at");
  });
});
