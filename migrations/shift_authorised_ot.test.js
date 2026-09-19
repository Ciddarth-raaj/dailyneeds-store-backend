/**
 * The shift-authorised OT migration: PROVENANCE ONLY, and additive.
 *
 *   node --test migrations/shift_authorised_ot.test.js
 *
 * The thing worth defending here is what the migration does NOT do. The
 * authorisation is not stored: it is the override's existing link to its
 * approved request, read on every calculation. These columns hold the answer
 * the engine reached and why, so a payslip query need not re-resolve it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const NAME = "20261030120000-shift-authorised-ot";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("touches ONE table, creates none, and rewrites no row", () => {
    assert.equal(up.filter((s) => /^CREATE TABLE/i.test(s)).length, 0);
    const altered = up
      .filter((s) => /^ALTER TABLE/i.test(s))
      .map((s) => /^ALTER TABLE `([a-z_]+)`/.exec(s)[1]);
    assert.deepEqual([...new Set(altered)], ["attendance_day_calculation"]);
    for (const statement of up) {
      assert.ok(!/^UPDATE|^DELETE|^TRUNCATE|^DROP TABLE/i.test(statement), statement.slice(0, 60));
      assert.ok(!/DROP COLUMN/i.test(statement), statement.slice(0, 60));
    }
  });

  it("stores the ANSWER and its provenance - never the authorisation itself", () => {
    const [alter] = up;
    assert.match(alter, /ADD COLUMN `shift_authorised_ot_minutes` INT NOT NULL DEFAULT 0/);
    assert.match(alter, /ADD COLUMN `approved_ot_source` ENUM\('OT_REQUEST','SHIFT_CHANGE'\) NULL/);
    assert.match(alter, /ADD COLUMN `ot_authorising_request_id` BIGINT UNSIGNED NULL/);

    // No flag on the OVERRIDE and no new table: the authorisation is the link
    // that already exists, and a second copy of it could drift from the first.
    const whole = read(`${NAME}-up.sql`);
    assert.ok(!/ALTER TABLE `attendance_date_shift_override`/.test(whole));
    assert.ok(!/ALTER TABLE `attendance_approval_request`/.test(whole));
    assert.ok(!/CREATE TABLE/.test(whole));
  });

  it("declares no permission - an approval already granted is not a new right", () => {
    assert.equal(up.filter((s) => /all_permissions|INSERT INTO `permissions`/i.test(s)).length, 0);
  });

  it("the down file drops exactly what the up file added", () => {
    const dropped = down.join(" ");
    for (const column of [
      "shift_authorised_ot_minutes",
      "approved_ot_source",
      "ot_authorising_request_id",
    ]) {
      assert.match(dropped, new RegExp(`DROP COLUMN \`${column}\``), column);
    }
    // And reversing it cannot lose the authorisation, because the
    // authorisation was never in these columns.
    assert.ok(!/attendance_date_shift_override|attendance_approval_request/.test(dropped));
  });
});
