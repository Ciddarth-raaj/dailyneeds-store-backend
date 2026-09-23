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

const fs = require("fs");
const path = require("path");

const buildRepo = require("./attendance_calculation");
const { writeCalculationsOnConnection } = require("./attendance_calculation");

/**
 * A connection standing in for one transaction.
 *
 * `payrun` is the payrun_employee_calculation table as the test wants it -
 * EVERY row, at whatever status, not only the locked ones. The gate locates
 * rows by identity and locks them; what it does about their status is its
 * decision, made afterwards, and a fake that pre-filtered by status would
 * hide exactly the defect this file exists to catch.
 */
function fakeConnection({ payrun = [], failOn = null } = {}) {
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });
      if (failOn && text.includes(failOn)) {
        cb(new Error(`forced failure on ${failOn}`));
        return;
      }
      if (/^SELECT/i.test(text)) {
        const [year, month, employeeIds] = params;
        cb(
          null,
          payrun.filter(
            (r) =>
              Number(r.period_year) === Number(year) &&
              Number(r.period_month) === Number(month) &&
              employeeIds.includes(Number(r.employee_id))
          )
        );
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

const locked = (employee_id, period_year, period_month) => ({
  employee_id,
  period_year,
  period_month,
  status: "APPROVED_LOCKED",
});
const calculated = (employee_id, period_year, period_month) => ({
  employee_id,
  period_year,
  period_month,
  status: "CALCULATED",
});

const LOCKED_AUGUST = [locked(42, 2026, 8)];

describe("the gate reads the payrun's own lock, and LOCKS the row", () => {
  it("selects FOR UPDATE, on the payrun's own table", async () => {
    const fake = fakeConnection();
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);

    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.match(select.sql, /FROM payrun_employee_calculation/);
    assert.match(select.sql, /FOR UPDATE$/, "the row is LOCKED, not merely looked at");
  });

  it("locates the row by IDENTITY - the status is never in the predicate", async () => {
    // `WHERE status = 'APPROVED_LOCKED' FOR UPDATE` locks only rows that are
    // ALREADY locked. A row sitting at CALCULATED matches nothing, is not
    // locked, and an approval is free to change it between this check and the
    // write - which is the whole race.
    const fake = fakeConnection();
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);

    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.ok(!/WHERE[^]*status/i.test(select.sql), "no status filter in the locking read");
    assert.ok(!select.params.includes("APPROVED_LOCKED"));
    assert.match(select.sql, /WHERE period_year = \? AND period_month = \? AND employee_id IN \(\?\)/);
    assert.deepEqual(select.params, [2026, 8, [42]]);
  });

  it("locks the SAME rows, the same way, as payrun approval does", async () => {
    // `repository/payrun_calculation.js#approveAndLock` re-reads
    //   WHERE period_year = ? AND period_month = ? AND employee_id = ? FOR UPDATE
    // so both transactions serialize on one key. This asserts the shape of
    // the key rather than the text of either statement.
    const fake = fakeConnection();
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));

    const approval = fs
      .readFileSync(path.join(__dirname, "payrun_calculation.js"), "utf8")
      .replace(/\s+/g, " ");
    assert.match(
      approval,
      /FROM payrun_employee_calculation WHERE period_year = \? AND period_month = \? AND employee_id = \? FOR UPDATE/,
      "the approval still locks by (period, employee) - if this moved, the gate must move with it"
    );
    assert.match(select.sql, /FOR UPDATE$/);
    assert.deepEqual(select.params.slice(0, 2), [2026, 8]);
  });

  it("a CALCULATED row is locked, and attendance proceeds", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);

    assert.equal(result.written, 1, "an unlocked month is written");
    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.match(select.sql, /FOR UPDATE$/, "and its row is held for the rest of the transaction");
  });

  it("an APPROVED_LOCKED row is locked, and the write is rejected", async () => {
    const fake = fakeConnection({ payrun: [locked(42, 2026, 8)] });
    await assert.rejects(
      () => writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]),
      /approved and locked/
    );
    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.match(select.sql, /FOR UPDATE$/);
    assert.ok(!fake.log.some((e) => /^INSERT/i.test(e.sql)));
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
    const fake = fakeConnection({ payrun: [] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    assert.equal(result.written, 1);
    assert.deepEqual(
      fake.log.map((e) => e.sql.split(" ")[0]),
      ["SELECT", "INSERT"]
    );
  });

  it("a DIFFERENT month of the same employee being locked does not block this one", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-09-10")]);
    assert.equal(result.written, 1);
    assert.ok(fake.log.some((e) => /^INSERT/i.test(e.sql)));
  });

  it("a DIFFERENT employee's lock does not block this one", async () => {
    const fake = fakeConnection({ payrun: [locked(99, 2026, 8)] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    assert.equal(result.written, 1);
  });
});

describe("a LOCKED month is refused, and nothing is written", () => {
  it("throws a business error naming the month, before any INSERT", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
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
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    await assert.rejects(
      () => writeCalculationsOnConnection(fake.connection, [row("2026-09-01"), row("2026-08-31")]),
      /approved and locked/
    );
    assert.ok(!fake.log.some((e) => /^INSERT/i.test(e.sql)));
  });

  it("the reconciling DELETE is refused too, and the transaction rolls back", async () => {
    // A date that is only being REMOVED carries no row in the write batch, so
    // it is gated on its own - otherwise a locked month could be emptied.
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
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

/* ======================================= scope, ordering and the wording == */

describe("only the employee/months the write touches are locked", () => {
  it("one statement per period, naming only that period's employees", async () => {
    const fake = fakeConnection();
    await writeCalculationsOnConnection(fake.connection, [
      row("2026-08-10", 42),
      row("2026-08-11", 42),
      row("2026-09-01", 42),
      row("2026-09-02", 7),
    ]);

    const selects = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.equal(selects.length, 2, "one per (year, month), not one per row and not one per employee");
    // Visited in a fixed order - period, then employee id - so two attendance
    // writes that overlap take the same locks in the same order.
    assert.deepEqual(selects[0].params, [2026, 8, [42]]);
    assert.deepEqual(selects[1].params, [2026, 9, [7, 42]]);
  });

  it("never locks a month the write does not touch", async () => {
    const fake = fakeConnection({ payrun: [locked(42, 2026, 7), calculated(42, 2026, 9)] });
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10", 42)]);

    const selects = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.equal(selects.length, 1);
    assert.deepEqual(selects[0].params, [2026, 8, [42]], "July and September are left free to be approved");
  });

  it("never locks an employee the write does not touch", async () => {
    const fake = fakeConnection({ payrun: [locked(99, 2026, 8)] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10", 42)]);
    assert.equal(result.written, 1);
    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.deepEqual(select.params[2], [42], "employee 99's locked August is not this write's business");
  });

  it("no payrun row for that employee/month: nothing can be locked, so attendance proceeds", async () => {
    const fake = fakeConnection({ payrun: [] });
    const result = await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    assert.equal(result.written, 1);
    assert.ok(fake.log.some((e) => /^INSERT/i.test(e.sql)));
  });
});

describe("the lock is taken before anything is modified", () => {
  it("SELECT ... FOR UPDATE precedes the upsert", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    await writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]);
    const order = fake.log.map((e) => e.sql.split(" ")[0]);
    assert.deepEqual(order, ["SELECT", "INSERT"]);
    assert.match(fake.log[0].sql, /FOR UPDATE$/);
  });

  it("SELECT ... FOR UPDATE precedes the reconciliation DELETE, inside the transaction", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    const repo = buildRepo(pool(fake));
    await repo.saveCalculationsWithReconciliation({
      employee_id: 42,
      from_date: "2026-08-01",
      to_date: "2026-08-31",
      rows: [row("2026-08-10")],
      ineligible_dates: ["2026-08-11"],
    });

    const order = fake.log.map((e) =>
      /^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(e.sql) ? e.sql : e.sql.split(" ")[0]
    );
    // The gate is AFTER the transaction begins and BEFORE each modification,
    // and the locks it takes are held until COMMIT.
    assert.deepEqual(order, ["BEGIN", "SELECT", "INSERT", "SELECT", "DELETE", "COMMIT", "RELEASE"]);
    fake.log
      .filter((e) => /^SELECT/i.test(e.sql))
      .forEach((e) => assert.match(e.sql, /FOR UPDATE$/));
  });

  it("a locked month reaches neither the INSERT nor the DELETE, and rolls back", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    const repo = buildRepo(pool(fake));
    await assert.rejects(
      () =>
        repo.saveCalculationsWithReconciliation({
          employee_id: 42,
          from_date: "2026-08-01",
          to_date: "2026-08-31",
          rows: [row("2026-08-10")],
          ineligible_dates: ["2026-08-11"],
        }),
      /approved and locked/
    );
    assert.ok(!fake.log.some((e) => /^(INSERT|UPDATE|DELETE)/i.test(e.sql)), "nothing was modified");
    assert.ok(fake.log.some((e) => e.sql === "ROLLBACK"));
    assert.ok(!fake.log.some((e) => e.sql === "COMMIT"));
  });
});

describe("the race the row lock closes", () => {
  it("an approval that lands between check and write waits on THIS transaction's lock", async () => {
    // The fake cannot run two real transactions, so what is asserted is the
    // property that makes the race impossible: both statements address the
    // same rows by the same key, and the attendance one holds them. An
    // approval arriving after this SELECT blocks on it until attendance
    // commits or rolls back - it cannot slip in and flip the status.
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    const repo = buildRepo(pool(fake));

    await repo.saveCalculationsWithReconciliation({
      employee_id: 42,
      from_date: "2026-08-01",
      to_date: "2026-08-31",
      rows: [row("2026-08-10")],
      ineligible_dates: [],
    });

    const selects = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    const beginAt = fake.log.findIndex((e) => e.sql === "BEGIN");
    const commitAt = fake.log.findIndex((e) => e.sql === "COMMIT");
    const insertAt = fake.log.findIndex((e) => /^INSERT/i.test(e.sql));
    const selectAt = fake.log.findIndex((e) => /^SELECT/i.test(e.sql));

    assert.ok(beginAt < selectAt, "the lock is taken INSIDE the transaction");
    assert.ok(selectAt < insertAt, "and before the write");
    assert.ok(insertAt < commitAt, "and released only by the commit");
    selects.forEach((e) => {
      assert.match(e.sql, /FOR UPDATE$/);
      assert.deepEqual(e.params.slice(0, 2), [2026, 8]);
    });
  });
});

describe("the refusal tells the truth and offers no way round it", () => {
  it("states the fact, names the month, and never says to reopen or unlock", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    await assert.rejects(
      () => writeCalculationsOnConnection(fake.connection, [row("2026-08-10")]),
      (err) => {
        assert.equal(
          err.message,
          "Attendance cannot be changed because payroll for this month is approved and locked - 08/2026 (employee 42)."
        );
        assert.ok(!/reopen|unlock|re-open/i.test(err.message), "a closed month is settled");
        assert.equal(err.name, "ValidationError");
        assert.equal(err.code, "PAYROLL_MONTH_LOCKED");
        return true;
      }
    );
  });
});

/* ============== the month: day rows and roll-up, one transaction, one lock = */

/**
 * `calculateMonth(persist=true)` used to make two calls - save the days, then
 * save the monthly roll-up - which left two holes: an approval could take the
 * payrun row between them, and a monthly write that failed after the daily
 * write had committed left a month whose halves disagreed. Both are now one
 * transaction under one lock.
 */
describe("saveMonthWithPayroll persists the whole month or none of it", () => {
  const monthly = { employee_id: 42, period_year: 2026, period_month: 8, salary_days: 26 };
  const saveMonth = (repo, over = {}) =>
    repo.saveMonthWithPayroll({
      employee_id: 42,
      period_year: 2026,
      period_month: 8,
      rows: [row("2026-08-10"), row("2026-08-11")],
      monthly,
      ...over,
    });

  it("BEGIN, lock, days, month, COMMIT - in that order and once each", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    const result = await saveMonth(buildRepo(pool(fake)));

    const order = fake.log.map((e) =>
      /^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(e.sql) ? e.sql : e.sql.split(" ")[0]
    );
    assert.deepEqual(order, ["BEGIN", "SELECT", "INSERT", "INSERT", "COMMIT", "RELEASE"]);
    assert.equal(result.written, 2);
    assert.equal(result.monthly_written, 1);
  });

  it("the lock is taken after BEGIN and before EITHER write, and is FOR UPDATE", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    await saveMonth(buildRepo(pool(fake)));

    const at = (pred) => fake.log.findIndex(pred);
    const beginAt = at((e) => e.sql === "BEGIN");
    const selectAt = at((e) => /^SELECT/i.test(e.sql));
    const dayAt = at((e) => /attendance_day_calculation/i.test(e.sql));
    const monthAt = at((e) => /attendance_monthly_payroll/i.test(e.sql));
    const commitAt = at((e) => e.sql === "COMMIT");

    assert.ok(beginAt < selectAt && selectAt < dayAt && dayAt < monthAt && monthAt < commitAt);
    assert.match(fake.log[selectAt].sql, /FOR UPDATE$/);
    // ONE gate for the whole month, not one per write.
    assert.equal(fake.log.filter((e) => /^SELECT/i.test(e.sql)).length, 1);
  });

  it("writes the days into one table and the month into the other", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    await saveMonth(buildRepo(pool(fake)));
    const inserts = fake.log.filter((e) => /^INSERT/i.test(e.sql));
    assert.match(inserts[0].sql, /INSERT INTO attendance_day_calculation/);
    assert.match(inserts[1].sql, /INSERT INTO attendance_monthly_payroll/);
    assert.match(inserts[1].sql, /ON DUPLICATE KEY UPDATE/, "idempotent, like the daily write");
  });

  it("a FAILING monthly write rolls the DAY rows back - no half-written month", async () => {
    const fake = fakeConnection({
      payrun: [calculated(42, 2026, 8)],
      failOn: "attendance_monthly_payroll",
    });
    await assert.rejects(() => saveMonth(buildRepo(pool(fake))), /forced failure/);
    assert.ok(fake.log.some((e) => e.sql === "ROLLBACK"));
    assert.ok(!fake.log.some((e) => e.sql === "COMMIT"), "the day rows do not survive alone");
  });

  it("a LOCKED month writes NEITHER table", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    await assert.rejects(() => saveMonth(buildRepo(pool(fake))), /approved and locked/);
    assert.ok(!fake.log.some((e) => /^INSERT/i.test(e.sql)));
    assert.ok(fake.log.some((e) => e.sql === "ROLLBACK"));
  });

  it("locks the month EVEN WITH NO DAY ROWS, so an empty month is still gated", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    await assert.rejects(
      () => saveMonth(buildRepo(pool(fake)), { rows: [] }),
      /approved and locked/
    );
    const [select] = fake.log.filter((e) => /^SELECT/i.test(e.sql));
    assert.deepEqual(select.params, [2026, 8, [42]]);
  });

  it("holds the lock across BOTH writes, so an approval cannot interleave", async () => {
    // The lock is taken before the first INSERT and released only by the
    // COMMIT after the second, so there is no instant between the day rows
    // and the roll-up at which an approval could take the row.
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    await saveMonth(buildRepo(pool(fake)));
    const order = fake.log.map((e) => e.sql);
    const selectAt = order.findIndex((sql) => /^SELECT/i.test(sql));
    const commitAt = order.indexOf("COMMIT");
    const inserts = order
      .map((sql, i) => (/^INSERT/i.test(sql) ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(inserts.every((i) => i > selectAt && i < commitAt));
  });
});

describe("no unguarded writer of attendance_monthly_payroll remains", () => {
  it("the repository exposes no saveMonthlyPayroll", () => {
    const repo = buildRepo(pool(fakeConnection()));
    assert.equal(repo.saveMonthlyPayroll, undefined, "the old unguarded method is gone, not deprecated");
  });

  it("the table is named in exactly one write, inside the guarded month save", () => {
    const source = fs.readFileSync(path.join(__dirname, "attendance_calculation.js"), "utf8");
    const writes = source.match(/INSERT INTO attendance_monthly_payroll/g) || [];
    assert.equal(writes.length, 1);
    // And the function holding it is private: nothing outside this file can
    // reach it without going through `saveMonthWithPayroll`.
    assert.ok(!/module\.exports.*upsertMonthlyPayrollOnConnection/s.test(source));
  });

  it("no other repository writes that table at all", () => {
    const dir = __dirname;
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && f !== "attendance_calculation.js")
      .filter((f) => /(INSERT INTO|UPDATE|DELETE FROM)\s+attendance_monthly_payroll/i.test(
        fs.readFileSync(path.join(dir, f), "utf8")
      ));
    assert.deepEqual(offenders, []);
  });
});

/*
 * THE DEFERRED (OPEN-DATE) WRITES. A decision about a date whose attendance
 * day has not closed is committed WITHOUT its day row
 * (`utils/attendance_persist_guard.js`). The lock used to be taken because a
 * day row was written; with no day row it must still be taken, on the date,
 * before the decision's own writes - so a locked month refuses the decision
 * exactly as before, inside the transaction.
 */
describe("a decision committed WITHOUT its day row is still gated", () => {
  const RegularizationRepo = require("./attendance_regularization");
  const index = (log, pattern) => log.findIndex((e) => pattern.test(e.sql));

  const decide = (repo) =>
    repo.decideStage({
      requestId: 501,
      stageNo: 1,
      decision: "APPROVED",
      actorId: 1,
      remarks: null,
      adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 0 },
      calculations: [],
      shiftOverride: { employee_id: 42, attendance_date: "2026-08-23", work_shift_id: 9, previous_work_shift_id: 7, reason: "cover" },
      attendanceLock: { employee_id: 42, attendance_date: "2026-08-23" },
    });

  it("setDateShift's override alone: locked month -> refused before the INSERT, rolled back", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    const repo = buildRepo(pool(fake));
    await assert.rejects(
      repo.saveDateShiftOverrideWithCalculation({
        override: { employee_id: 42, attendance_date: "2026-08-23", work_shift_id: 9, previous_work_shift_id: 7, changed_by: 1 },
        rows: [],
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal(index(fake.log, /INSERT INTO attendance_date_shift_override/), -1);
    assert.ok(fake.log.some((e) => e.sql === "ROLLBACK"));
  });

  it("setDateShift's override alone: unlocked -> BEGIN, FOR UPDATE, INSERT override, COMMIT, and NO day row", async () => {
    const fake = fakeConnection({ payrun: [calculated(42, 2026, 8)] });
    const repo = buildRepo(pool(fake));
    await repo.saveDateShiftOverrideWithCalculation({
      override: { employee_id: 42, attendance_date: "2026-08-23", work_shift_id: 9, previous_work_shift_id: 7, changed_by: 1 },
      rows: [],
    });
    const lock = index(fake.log, /FOR UPDATE/);
    const insert = index(fake.log, /INSERT INTO attendance_date_shift_override/);
    assert.ok(lock > 0 && insert > lock, "the lock precedes the override");
    assert.equal(index(fake.log, /INSERT INTO attendance_day_calculation/), -1);
    assert.equal(fake.log[fake.log.length - 2].sql, "COMMIT");
  });

  it("an approval with its day deferred: locked month -> refused inside the transaction, nothing survives", async () => {
    const fake = fakeConnection({ payrun: LOCKED_AUGUST });
    const repo = RegularizationRepo(pool(fake));
    await assert.rejects(decide(repo), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    assert.equal(index(fake.log, /INSERT INTO attendance_date_shift_override/), -1);
    assert.ok(fake.log.some((e) => e.sql === "ROLLBACK"));
    assert.ok(!fake.log.some((e) => e.sql === "COMMIT"));
  });

  it("an approval with its day deferred: unlocked -> decision + override commit, and NO day row", async () => {
    const fake = fakeConnection({ payrun: [] });
    const repo = RegularizationRepo(pool(fake));
    const saved = await decide(repo);
    assert.equal(saved.code, 200);
    assert.equal(saved.calculations_written, 0);
    const lock = index(fake.log, /FOR UPDATE/);
    const insert = index(fake.log, /INSERT INTO attendance_date_shift_override/);
    assert.ok(lock > 0 && insert > lock);
    assert.equal(index(fake.log, /INSERT INTO attendance_day_calculation/), -1);
    assert.ok(fake.log.some((e) => e.sql === "COMMIT"));
  });
});
