/**
 * The Attendance Calculation Type history write, against the statements it
 * actually issues.
 *
 *   node --test repository/employee_attendance_mode.test.js
 *
 * What matters: the row is APPENDED (never an UPDATE or DELETE of history),
 * and the payroll lock is taken inside the same transaction, IN FRONT of the
 * insert, on the months the new row actually changes - so a change cannot
 * reach a payroll-locked month and there is no bypass.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./employee_attendance_mode");

function fakeDb({ history = [], payrun = [], employeeExists = true } = {}) {
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });
      if (/FROM new_employee WHERE employee_id = \? FOR UPDATE/.test(text)) {
        cb(null, employeeExists ? [{ employee_id: params[0] }] : []);
        return;
      }
      if (/FROM employee_attendance_calculation_mode/.test(text) && /^SELECT/.test(text)) {
        cb(null, history);
        return;
      }
      if (/FROM payrun_employee_calculation/.test(text)) {
        const [year, month, ids] = params;
        cb(
          null,
          payrun.filter(
            (r) => r.period_year === year && r.period_month === month && ids.includes(r.employee_id)
          )
        );
        return;
      }
      cb(null, { insertId: 77, affectedRows: 1 });
    },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => { log.push({ sql: "RELEASE" }); },
  };
  return {
    log,
    db: { getConnection: (cb) => cb(null, connection), query: connection.query },
  };
}

const locked = (period_year, period_month) => ({
  employee_id: 42,
  period_year,
  period_month,
  status: "APPROVED_LOCKED",
});

const append = (db, over = {}) =>
  buildRepo(db).appendMode({
    employeeId: 42,
    calculationMode: "PRESENT_ABSENT_ONLY",
    effectiveFrom: "2026-10-01",
    note: "",
    createdBy: 7,
    today: "2026-10-20",
    ...over,
  });

const statements = (log) => log.map((e) => e.sql);

describe("appendMode", () => {
  it("appends inside one transaction, gate BEFORE the insert, and never updates or deletes history", async () => {
    const fake = fakeDb();
    const result = await append(fake.db);
    assert.equal(result.code, 200);
    const sql = statements(fake.log);
    const gate = sql.findIndex((s) => /FROM payrun_employee_calculation/.test(s));
    const insert = sql.findIndex((s) => /^INSERT INTO employee_attendance_calculation_mode/.test(s));
    assert.ok(sql[0] === "BEGIN");
    assert.ok(gate > 0 && insert > gate, "the lock is taken in front of the insert");
    assert.match(sql[gate], /FOR UPDATE$/);
    assert.ok(sql.includes("COMMIT"));
    assert.equal(sql.filter((s) => /^(UPDATE|DELETE)/.test(s)).length, 0);
  });

  it("a change reaching a LOCKED month is refused: no insert, rolled back", async () => {
    const fake = fakeDb({ payrun: [locked(2026, 10)] });
    await assert.rejects(() => append(fake.db), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    const sql = statements(fake.log);
    assert.equal(sql.filter((s) => /^INSERT/.test(s)).length, 0);
    assert.ok(sql.includes("ROLLBACK"));
    assert.ok(!sql.includes("COMMIT"));
  });

  it("a backdated change is refused when ANY month it moves is locked", async () => {
    const fake = fakeDb({ payrun: [locked(2026, 9)] });
    await assert.rejects(
      () => append(fake.db, { effectiveFrom: "2026-09-20" }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
  });

  it("a locked month BEFORE the effective date does not block it", async () => {
    const fake = fakeDb({ payrun: [locked(2026, 9)] });
    const result = await append(fake.db, { effectiveFrom: "2026-10-01" });
    assert.equal(result.code, 200);
  });

  it("a locked month a LATER row already governs does not block a change that cannot reach it", async () => {
    const fake = fakeDb({
      payrun: [locked(2026, 11)],
      history: [
        { employee_attendance_calculation_mode_id: 5, employee_id: 42, calculation_mode: "SHIFT_BASED", effective_from: "2026-11-01" },
      ],
    });
    const result = await append(fake.db, { effectiveFrom: "2026-10-01", today: "2026-11-20" });
    assert.equal(result.code, 200);
    assert.equal(result.affected_to, "2026-10-31");
  });

  it("an unknown employee is a 404 and nothing is written", async () => {
    const fake = fakeDb({ employeeExists: false });
    const result = await append(fake.db);
    assert.equal(result.code, 404);
    assert.equal(statements(fake.log).filter((s) => /^INSERT/.test(s)).length, 0);
  });
});

describe("recalculating a Present/Absent Only date in a locked month", () => {
  const { writeCalculationsOnConnection } = require("./attendance_calculation");
  const buildCalculation = require("../usecase/attendance_calculation");
  const { calculateAttendanceDay } = require("../utils/attendance_engine");

  it("is refused by the one existing write gate - the mode opens no way round it", async () => {
    const storageRow = buildCalculation({}).toStorageRow(
      calculateAttendanceDay({
        employee_id: 42,
        attendance_date: "2026-10-05",
        punches: [{ punch_id: 1, io_time: "2026-10-05 09:00:00" }],
        attendance_calculation_mode: "PRESENT_ABSENT_ONLY",
      })
    );
    assert.equal(storageRow.attendance_calculation_mode, "PRESENT_ABSENT_ONLY");

    const fake = fakeDb({ payrun: [locked(2026, 10)] });
    const connection = await new Promise((r) => fake.db.getConnection((_e, c) => r(c)));
    await assert.rejects(
      () => writeCalculationsOnConnection(connection, [storageRow]),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal(statements(fake.log).filter((s) => /^INSERT INTO attendance_day_calculation/.test(s)).length, 0);
  });
});
