/**
 * The three Attendance v2 migrations are additive, guarded, re-runnable, and
 * touch nothing that already exists.
 *
 *   node --test migrations/attendance_v2_migrations.test.js
 *
 * Proven against the SQL text - there is no database here - which is the same
 * way `employee_default_work_shift.test.js` and `hr_permission_keys_b2.test.js`
 * prove theirs. That suits what matters most about these: what they must NOT
 * do. They must not ALTER an existing table, must not write to `biomax_punch`,
 * must not revoke a permission, and must not invent shift history for a date
 * the database has no record of.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

/**
 * The statement with every quoted literal blanked out.
 *
 * A column COMMENT is a string literal, and several of them mention the legacy
 * `shift_master` precisely to say it is NOT read. Checking the raw text would
 * fail on the sentence that promises the thing the check is testing for.
 */
const withoutLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''");

const NAMES = [
  "20260917120000-attendance-v2-shift-history",
  "20260918120000-attendance-v2-calculation",
  "20260919120000-attendance-v2-approvals",
];

describe("every Attendance v2 migration", () => {
  NAMES.forEach((name) => {
    describe(name, () => {
      const up = statements(read(`${name}-up.sql`));
      const down = statements(read(`${name}-down.sql`));

      it("has an up and a down", () => {
        assert.ok(up.length > 0);
        assert.ok(down.length > 0);
      });

      it("creates every table with IF NOT EXISTS, so a re-run is a no-op", () => {
        up
          .filter((s) => /^CREATE TABLE/i.test(s))
          .forEach((s) => assert.match(s, /^CREATE TABLE IF NOT EXISTS/i));
      });

      it("ALTERs nothing - no existing table is modified", () => {
        up.forEach((s) => assert.ok(!/^ALTER TABLE/i.test(s), `unexpected ALTER: ${s}`));
      });

      it("never writes to a Biomax punch table", () => {
        up.forEach((s) => {
          assert.ok(
            !/^(INSERT|UPDATE|DELETE)[\s\S]*biomax_punch/i.test(s),
            `a punch table is written: ${s}`
          );
        });
      });

      it("never drops or truncates anything on the way up", () => {
        up.forEach((s) => {
          assert.ok(!/^DROP/i.test(s), `unexpected DROP: ${s}`);
          assert.ok(!/^TRUNCATE/i.test(s), `unexpected TRUNCATE: ${s}`);
        });
      });

      it("revokes no existing permission", () => {
        up.forEach((s) => {
          assert.ok(
            !/^DELETE[\s\S]*FROM `?(permissions|all_permissions)`?/i.test(s),
            `a grant is removed on the way up: ${s}`
          );
          assert.ok(
            !/^UPDATE[\s\S]*`?permissions`?[\s\S]*is_active/i.test(s),
            `a grant is deactivated: ${s}`
          );
        });
      });

      it("guards every INSERT so a second run inserts nothing", () => {
        up
          .filter((s) => /^INSERT/i.test(s))
          .forEach((s) =>
            assert.match(s, /NOT EXISTS\s*\(/i, `an unguarded INSERT would duplicate: ${s}`)
          );
      });

      it("drops on the way down only what it created on the way up", () => {
        const created = up
          .filter((s) => /^CREATE TABLE/i.test(s))
          .map((s) => /CREATE TABLE IF NOT EXISTS `([^`]+)`/i.exec(s)[1]);
        const dropped = down
          .filter((s) => /^DROP TABLE/i.test(s))
          .map((s) => /DROP TABLE IF EXISTS `([^`]+)`/i.exec(s)[1]);
        created.forEach((table) =>
          assert.ok(dropped.includes(table), `${table} is created but never dropped`)
        );
        dropped.forEach((table) =>
          assert.ok(created.includes(table), `${table} is dropped but never created here`)
        );
      });
    });
  });
});

describe("A0 - the shift history migration", () => {
  const name = NAMES[0];
  const up = statements(read(`${name}-up.sql`));
  const inserts = up.filter((s) => /^INSERT/i.test(s));

  it("creates exactly one table", () => {
    assert.equal(up.filter((s) => /^CREATE TABLE/i.test(s)).length, 1);
    assert.match(up[0], /CREATE TABLE IF NOT EXISTS `employee_work_shift_assignment`/);
  });

  it("has NO unique key on (employee_id, effective_from), so a correction is insertable", () => {
    assert.ok(
      !/UNIQUE KEY[^,]*`employee_id`[^,]*`effective_from`/i.test(up[0]),
      "a unique key there would make an append-only correction impossible"
    );
  });

  it("backfills only employees who ALREADY have a default work shift", () => {
    assert.equal(inserts.length, 1);
    assert.match(inserts[0], /WHERE ne\.`default_work_shift_id` IS NOT NULL/);
  });

  it("dates the backfill at the cutover and invents nothing earlier", () => {
    assert.match(inserts[0], /'2026-09-01'/);
    assert.match(inserts[0], /'MIGRATION_BACKFILL'/);
    // Exactly one date literal: no second, earlier row is written anywhere.
    assert.equal((inserts[0].match(/'\d{4}-\d{2}-\d{2}'/g) || []).length, 1);
  });

  it("reads nothing from the legacy shift master", () => {
    up.map(withoutLiterals).forEach((s) => {
      assert.ok(!/shift_master/i.test(s), `the legacy shift master is read: ${s}`);
      assert.ok(!/`shift_code`/i.test(s), `the Digisme shift_code is read: ${s}`);
    });
  });

  it("writes to no table but its own", () => {
    inserts.forEach((s) =>
      assert.match(s, /^INSERT INTO `employee_work_shift_assignment`/)
    );
  });
});

describe("A1/A4 - the calculation migration", () => {
  const up = statements(read(`${NAMES[1]}-up.sql`));
  const text = stripComments(read(`${NAMES[1]}-up.sql`));

  it("creates the three derived tables", () => {
    const created = up
      .filter((s) => /^CREATE TABLE/i.test(s))
      .map((s) => /CREATE TABLE IF NOT EXISTS `([^`]+)`/i.exec(s)[1]);
    assert.deepEqual(created.sort(), [
      "attendance_day_calculation",
      "attendance_monthly_payroll",
      "employee_break_override",
    ]);
  });

  it("makes a recalculation idempotent by unique key", () => {
    assert.match(text, /UNIQUE KEY `uq_adc_employee_date` \(`employee_id`, `attendance_date`\)/);
    assert.match(
      text,
      /UNIQUE KEY `uq_amp_employee_period` \(`employee_id`, `period_year`, `period_month`\)/
    );
  });

  it("stores the shift snapshot and its hash, so a recomputation is auditable", () => {
    assert.match(text, /`shift_snapshot`\s+JSON NOT NULL/);
    assert.match(text, /`shift_snapshot_hash` CHAR\(32\) NOT NULL/);
  });

  it("has no FULL_DAY / HALF_DAY column anywhere - v2 does not classify a day", () => {
    assert.ok(!/HALF_DAY|FULL_DAY|QUARTER_DAY/i.test(text));
  });

  it("grants the pay-affecting break override key to nobody", () => {
    const grants = up.filter((s) => /^INSERT INTO `permissions`/i.test(s));
    grants.forEach((s) =>
      assert.ok(
        !/manage_employee_break_override/.test(s),
        "the break override key must not be granted by a migration"
      )
    );
  });
});

describe("A3 - the approvals migration", () => {
  const up = statements(read(`${NAMES[2]}-up.sql`));
  const text = stripComments(read(`${NAMES[2]}-up.sql`));

  it("creates the four approval tables", () => {
    const created = up
      .filter((s) => /^CREATE TABLE/i.test(s))
      .map((s) => /CREATE TABLE IF NOT EXISTS `([^`]+)`/i.exec(s)[1]);
    assert.deepEqual(created.sort(), [
      "attendance_approval_request",
      "attendance_approval_role",
      "attendance_approval_step",
      "attendance_regularized_punch",
    ]);
  });

  it("allows only one OPEN request per employee and date", () => {
    assert.match(
      text,
      /UNIQUE KEY `uq_aareq_open_per_employee_date`\s+\(`requested_for_employee_id`, `open_attendance_date`\)/
    );
    assert.match(text, /CASE WHEN `status` = 'PENDING' THEN `attendance_date` ELSE NULL END/);
  });

  it("stores a regularized punch at most once per request", () => {
    assert.match(text, /UNIQUE KEY `uq_arp_request` \(`attendance_approval_request_id`\)/);
  });

  it("marks the manual punch as REGULARIZED and nothing else", () => {
    assert.match(text, /`punch_source`\s+ENUM\('REGULARIZED'\) NOT NULL DEFAULT 'REGULARIZED'/);
  });

  it("guesses no designation into an approval role but the one already relied on by name", () => {
    const seeds = up.filter((s) => /^INSERT INTO `attendance_approval_role`/i.test(s));
    assert.equal(seeds.length, 1);
    assert.match(seeds[0], /'HR EXECUTIVE'/);
    // No other designation name is matched anywhere in the file.
    const names = text.match(/UPPER\(TRIM\(\w*\.?`designation_name`\)\) = '([^']+)'/g) || [];
    assert.deepEqual([...new Set(names.map((n) => /'([^']+)'/.exec(n)[1]))], ["HR EXECUTIVE"]);
  });

  it("grants neither decision key", () => {
    const grants = up.filter((s) => /^INSERT INTO `permissions`/i.test(s));
    grants.forEach((s) => {
      assert.ok(!/approve_attendance_regularization/.test(s));
      assert.ok(!/manage_attendance_approval_roles/.test(s));
      assert.ok(!/raise_attendance_regularization_for_others/.test(s));
    });
  });

  it("records an administrator short-cut rather than hiding it", () => {
    assert.match(text, /`acted_as_admin_override` TINYINT\(1\) NOT NULL DEFAULT 0/);
  });
});

describe("the migration timestamps", () => {
  it("sort after M4, the newest migration they build on", () => {
    NAMES.forEach((name) => assert.ok(name > "20260916120000-m4", `${name} sorts too early`));
  });

  it("are in the order the tables depend on each other", () => {
    assert.deepEqual([...NAMES].sort(), NAMES);
  });
});
