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

      /**
       * The only ALTER any of these may carry is an ADD COLUMN of a new,
       * nullable field - the shape 20260910120000 already uses to put
       * `default_work_shift_id` on `new_employee`, and the shape the v2
       * product contract requires for the Special Break Duration Override.
       *
       * What must stay impossible is anything that changes or removes what is
       * already there: no MODIFY, no CHANGE, no DROP COLUMN, no RENAME, and no
       * NOT NULL on a column being added to a populated table.
       */
      it("modifies nothing that already exists - an ALTER may only ADD a nullable column", () => {
        up
          .filter((s) => /^ALTER TABLE/i.test(s))
          .forEach((s) => {
            assert.ok(!/\bMODIFY\b/i.test(s), `an existing column is modified: ${s}`);
            assert.ok(!/\bCHANGE\b/i.test(s), `an existing column is changed: ${s}`);
            assert.ok(!/\bDROP\b/i.test(s), `something is dropped: ${s}`);
            assert.ok(!/\bRENAME\b/i.test(s), `something is renamed: ${s}`);
            assert.match(s, /ADD COLUMN/i, `an ALTER that adds no column: ${s}`);
            assert.match(s, /NULL DEFAULT NULL/i, `a column added here must be nullable: ${s}`);
          });
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

  it("creates the assignment history and the shift configuration history", () => {
    const created = up
      .filter((s) => /^CREATE TABLE/i.test(s))
      .map((s) => /CREATE TABLE IF NOT EXISTS `([^`]+)`/i.exec(s)[1]);
    assert.deepEqual(created.sort(), [
      "employee_work_shift_assignment",
      "work_shift_config_version",
    ]);
  });

  /**
   * Review fix #2. Without a version dated at the cutover, a September date
   * that resolved to "no version yet" would fall back to the LIVE tables and
   * therefore read whatever a later edit put there - which is the whole bug.
   */
  it("seeds one configuration version per existing shift, dated at the cutover", () => {
    const seed = inserts.find((s) => /^INSERT INTO `work_shift_config_version`/.test(s));
    assert.ok(seed, "no configuration version is seeded");
    assert.match(seed, /'2026-09-01'/);
    assert.match(seed, /'MIGRATION_SEED'/);
    assert.match(seed, /FROM `work_shift` ws/);
  });

  it("has NO unique key on the configuration history either, so a same-day correction fits", () => {
    const create = up.find((s) => /CREATE TABLE IF NOT EXISTS `work_shift_config_version`/.test(s));
    assert.ok(!/UNIQUE KEY[^,]*`work_shift_id`[^,]*`effective_from`/i.test(create));
  });

  it("has NO unique key on (employee_id, effective_from), so a correction is insertable", () => {
    assert.ok(
      !/UNIQUE KEY[^,]*`employee_id`[^,]*`effective_from`/i.test(up[0]),
      "a unique key there would make an append-only correction impossible"
    );
  });

  const assignmentBackfill = () =>
    inserts.find((s) => /^INSERT INTO `employee_work_shift_assignment`/.test(s));

  it("backfills only employees who ALREADY have a default work shift", () => {
    assert.match(assignmentBackfill(), /WHERE ne\.`default_work_shift_id` IS NOT NULL/);
  });

  it("dates the backfill at the cutover and invents nothing earlier", () => {
    const backfill = assignmentBackfill();
    assert.match(backfill, /'2026-09-01'/);
    assert.match(backfill, /'MIGRATION_BACKFILL'/);
    // Exactly one date literal: no second, earlier row is written anywhere.
    assert.equal((backfill.match(/'\d{4}-\d{2}-\d{2}'/g) || []).length, 1);
  });

  it("dates every seeded configuration version at the cutover too, and no earlier", () => {
    const seed = inserts.find((s) => /^INSERT INTO `work_shift_config_version`/.test(s));
    assert.equal((seed.match(/'\d{4}-\d{2}-\d{2}'/g) || []).length, 1);
  });

  it("reads nothing from the legacy shift master", () => {
    up.map(withoutLiterals).forEach((s) => {
      assert.ok(!/shift_master/i.test(s), `the legacy shift master is read: ${s}`);
      // `new_employee.shift_code` is the Digisme text column and must never be
      // read. `work_shift.shift_code` is the NEW master's own code and is part
      // of the configuration a version snapshots; it is qualified `ws.`, which
      // is what tells the two apart.
      assert.ok(
        !/(?<!ws\.)`shift_code`/i.test(s) || /`work_shift`/i.test(s),
        `the Digisme shift_code is read: ${s}`
      );
    });
  });

  it("writes to no table but the two it creates, and no permission grant", () => {
    inserts.forEach((s) =>
      assert.match(
        s,
        /^INSERT INTO `(employee_work_shift_assignment|work_shift_config_version|all_permissions)`/
      )
    );
    assert.ok(
      !up.some((s) => /^INSERT INTO `permissions`/i.test(s)),
      "the correction key is declared but granted to nobody"
    );
  });
});

describe("A1/A4 - the calculation migration", () => {
  const up = statements(read(`${NAMES[1]}-up.sql`));
  const text = stripComments(read(`${NAMES[1]}-up.sql`));

  it("creates the two derived tables and no dated break-override table", () => {
    const created = up
      .filter((s) => /^CREATE TABLE/i.test(s))
      .map((s) => /CREATE TABLE IF NOT EXISTS `([^`]+)`/i.exec(s)[1]);
    assert.deepEqual(created.sort(), [
      "attendance_day_calculation",
      "attendance_monthly_payroll",
    ]);
  });

  /**
   * Review fix #7. The product contract gives Employee Master ONE current
   * Special Break Duration Override with no Effective From, so there must be
   * no effective-dated override table and no effective_from/effective_to
   * anywhere near it.
   */
  it("puts the break override on Employee Master as one undated, nullable field", () => {
    assert.ok(!/employee_break_override`/.test(text), "the dated override table is gone");
    assert.match(
      text,
      /ALTER TABLE `new_employee`\s+ADD COLUMN `special_break_override_minutes` INT NULL DEFAULT NULL/
    );
    assert.ok(
      !/special_break_override[\s\S]{0,400}effective_(from|to)/i.test(text),
      "the override must carry no effective date"
    );
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

  /**
   * Review fix #9. Somebody entitled to see how long a colleague worked is not
   * thereby entitled to see what those minutes are worth, and re-running the
   * engine rewrites what payroll reads - so neither key is handed to HR by a
   * migration. Both are DECLARED, so an administrator can assign them on the
   * existing designation rights screen.
   */
  it("declares the payroll and recalculation keys but grants them to nobody", () => {
    const declared = up.filter((s) => /^INSERT INTO `all_permissions`/i.test(s)).join(" ");
    assert.match(declared, /'view_attendance_payroll'/);
    assert.match(declared, /'recalculate_attendance'/);

    const grants = up.filter((s) => /^INSERT INTO `permissions`/i.test(s));
    grants.forEach((s) => {
      assert.ok(!/view_attendance_payroll/.test(s), "HR must not get payroll report access");
      assert.ok(!/recalculate_attendance/.test(s), "recalculation rewrites payroll-consumed data");
    });
  });

  it("still grants HR the attendance read, which is its operational role", () => {
    const grants = up.filter((s) => /^INSERT INTO `permissions`/i.test(s));
    assert.equal(grants.length, 1);
    assert.match(grants[0], /'view_calculated_attendance'/);
    assert.match(grants[0], /'HR EXECUTIVE'/);
  });

  /**
   * Review fix #8. Attendance exposes neutral wage components; it does not
   * name a legal PF/ESI base, because that determination is salary_engine.js's
   * and not an attendance calculator's to make.
   */
  it("stores neutral wage components and asserts no statutory base", () => {
    assert.match(text, /`salary_day_earnings` DECIMAL\(12,2\) NULL/);
    assert.match(text, /`extra_day_earnings`\s+DECIMAL\(12,2\) NULL/);
    assert.match(text, /`approved_ot_earnings` DECIMAL\(12,2\) NULL/);
    assert.ok(!/`statutory_base_days`/.test(text));
    assert.ok(!/`statutory_base_earnings`/.test(text));
  });

  /** Review fix #5: every OT figure the engine produced is stored. */
  it("stores every intermediate overtime figure the shift rules produced", () => {
    ["pre_shift_minutes", "post_shift_minutes", "ot_offset_minutes",
     "pre_shift_ot_minutes", "post_shift_ot_minutes"].forEach((column) =>
      assert.match(text, new RegExp("`" + column + "`\\s+INT"))
    );
  });

  /** Review fix #2: a stored calculation names the configuration version it read. */
  it("records which dated configuration version a calculation consumed", () => {
    assert.match(text, /`work_shift_config_version_id` BIGINT UNSIGNED NULL/);
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

  /** Review fix #6: the queue can tell its own requests from a person's. */
  it("marks a request the OT auto-queue raised", () => {
    assert.match(text, /`auto_created` TINYINT\(1\) NOT NULL DEFAULT 0/);
  });

  /**
   * Review fix #4: a final decision and the recalculated day commit together,
   * so SETTLED is reached in the same commit as APPROVED and payroll treats
   * anything else as not final.
   */
  it("carries the finalization state payroll reads", () => {
    assert.match(
      text,
      /`finalization_state` ENUM\('NOT_REQUIRED','PENDING','SETTLED'\) NOT NULL DEFAULT 'NOT_REQUIRED'/
    );
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
