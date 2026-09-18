/**
 * THE PAYROLL LOCK GATE, driven against the statements it actually issues.
 *
 *   node --test repository/attendance_payroll_lock.test.js
 *
 * A closed month cannot be modified by anyone, and "anyone" includes the
 * attendance engine. Every path that persists attendance reaches this
 * repository, and this repository reaches the database through exactly two
 * statements: the upsert and the reconciling delete. Both are gated here, so
 * what is asserted below is that the gate is IN FRONT of them - not beside
 * them, and not in a usecase somebody can forget to call.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./attendance_calculation");
const { writeCalculationsOnConnection } = require("./attendance_calculation");

/**
 * A connection that answers the lock SELECT with whatever the test says is
 * locked, and records every statement in order.
 */
function fakeConnection({ locked = [] } = {}) {
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });
      if (/^SELECT/i.test(text)) {
        cb(null, locked);
        return;
      }
      cb(null, { affectedRows: 1 });
    },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => { log.push({ sql: "RELEASE" }); },
  };
  return { log, connection };
}

const pool = (fake) => ({
  getConnection: (cb) => cb(null, fake.connection),
  query: (sql, params, cb) => fake.connection.query(sql, params, cb),
});

const row = (attendance_date, employee_id = 42) => ({
  employee_id,
  attendance_date,
  work_shift_id: 7,
  shift_snapshot: "{}",
  shift_snapshot_hash: "h",
  raw_punch_ids: "[]",
  effective_punches: "[]",
  punch_count: 4,
  nrm_minutes: 630,
  break_allowance_minutes: 90,
  break_allowance_source: "EMPLOYEE_OVERRIDE",
  break_override_minutes_applied: null,
  extra_break_minutes_applied: 30,
  status: "FINAL",
  is_final: 1,
  review_reasons: "[]",
  calculation_version: 7,
});

const LOCKED_AUGUST = [{ employee_id: 42, period_year: 2026, period_month: 8 }];

describe("the gate reads the payrun's own lock", () => {
  it("asks payrun_employee_calculation for APPROVED_LOCKED, by employee", async () => {
    const fake = fakeConnection();
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);

    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.match(select.sql, /FROM payrun_employee_calculation/);
    assert.match(select.sql, /WHERE status = \?/);
    assert.deepEqual(select.params, ["APPROVED_LOCKED", [42]]);
  });

  it("invents no second lock table, flag or status of its own", async () => {
    const fake = fakeConnection();
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    const sql = fake.log.map((e) => e.sql).join(" | ");
    assert.ok(!/attendance_lock|month_lock|is_locked/i.test(sql));
  });
});

describe("an UNLOCKED month is written exactly as before", () => {
  it("the gate runs first, then the INSERT", async () => {
    const fake = fakeConnection({ locked: [] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    assert.equal(result.written, 1);
    assert.deepEqual(
      fake.log.map((e) => e.sql.split(" ")[0]),
      ["SELECT", "INSERT"]
    );
  });

  it("a DIFFERENT month of the same employee being locked does not block this one", async () => {
    const fake = fakeConnection({ locked: LOCKED_AUGUST });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-09-10")]);
    assert.equal(result.written, 1);
    assert.ok(fake.log.some((e) => /^INSERT/i.test(e.sql)));
  });

  it("a DIFFERENT employee's lock does not block this one", async () => {
    const fake = fakeConnection({ locked: [{ employee_id: 99, period_year: 2026, period_month: 8 }] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    assert.equal(result.written, 1);
  });
});

describe("a LOCKED month is refused, and nothing is written", () => {
  it("throws a business error naming the month, before any INSERT", async () => {
    const fake = fakeConnection({ locked: LOCKED_AUGUST });
    await assert.rejects(
      () => writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]),
      (err) => {
        assert.equal(err.name, "ValidationError", "422, not a 500");
        assert.equal(err.code, "PAYROLL_MONTH_LOCKED");
        assert.match(err.message, /approved and locked/);
        assert.match(err.message, /08\/2026 \(employee 42\)/);
        assert.deepEqual(err.locked_months, [{ employee_id: 42, year: 2026, month: 8 }]);
        return true;
      }
    );
    assert.ok(!fake.log.some((e) => /^INSERT/i.test(e.sql)), "no row was written");
  });

  it("one locked date in a batch refuses the WHOLE batch", async () => {
    // A recalculation is a range. Writing the unlocked half and dropping the
    // rest would leave a month half restated with nothing to say which half.
    const fake = fakeConnection({ locked: LOCKED_AUGUST });
    await assert.rejects(
      () => writeCalculationsOnConnection(fake.connection, [row("2026-09-01"), row("2026-08-31")]),
      /approved and locked/
    );
    assert.ok(!fake.log.some((e) => /^INSERT/i.test(e.sql)));
  });

  it("the reconciling DELETE is refused too, and the transaction rolls back", async () => {
    // A date that is only being REMOVED carries no row in the write batch, so
    // it is gated on its own - otherwise a locked month could be emptied.
    const fake = fakeConnection({ locked: LOCKED_AUGUST });
    const repo = buildRepo(pool(fake));
    await assert.rejects(
      () =>
        repo.saveCalculationsWithReconciliation({
          employee_id: 42,
          from_date: "2026-08-01",
          to_date: "2026-08-31",
          rows: [],
          ineligible_dates: ["2026-08-10"],
        }),
      /approved and locked/
    );
    assert.ok(!fake.log.some((e) => /^DELETE/i.test(e.sql)), "nothing was deleted");
    assert.ok(fake.log.some((e) => e.sql === "ROLLBACK"));
    assert.ok(!fake.log.some((e) => e.sql === "COMMIT"));
  });
});

describe("what the gate refuses to guess", () => {
  it("a row with no readable employee and date is refused rather than written ungated", async () => {
    const fake = fakeConnection();
    await assert.rejects(
      () => writeCalculationsOnConnection(fake.connection, [{ employee_id: null, attendance_date: null }]),
      /no readable employee and date/
    );
    assert.equal(fake.log.length, 0);
  });

  it("an empty batch touches nothing at all", async () => {
    const fake = fakeConnection();
    const result = await writeCalculationsOnConnection(fake.connection, []);
    assert.deepEqual(result, { written: 0 });
    assert.equal(fake.log.length, 0);
  });
});
