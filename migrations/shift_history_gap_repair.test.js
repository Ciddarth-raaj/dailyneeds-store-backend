/**
 * The second shift-history repair: history that begins AFTER the evidence.
 *
 *   node --test migrations/shift_history_gap_repair.test.js
 *
 * THE DEFECT THIS EXISTS FOR. The Employee Shift Assignment screen dates an
 * assignment TODAY. For an employee who had no shift at all, that leaves
 * every earlier date resolving to NO_SHIFT for ever - so punches from the
 * 2nd to the 10th stay undatable after a shift is assigned on the 12th, and
 * no amount of recalculating changes it, because there genuinely is no
 * assignment covering those dates. The first repair migration cannot help:
 * its guard is "has no assignment row at all", which is exactly what makes
 * it safe and exactly what makes it skip this employee.
 *
 * As in `shift_history_repair_safety.test.js`, the migration's deciding
 * clauses are read out of the file and their semantics executed over
 * in-memory rows - the questions worth answering here are behavioural.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { resolveAssignmentForDate } = require("../utils/shiftResolution");

const NAME = "20261001120000-shift-history-gap-before-earliest";
const SQL = fs.readFileSync(
  path.join(__dirname, "mysql/migrations/sqls", `${NAME}-up.sql`),
  "utf8"
);
const CUTOVER = "2026-09-01";
const UNDATABLE = ["NO_SHIFT", "NO_SCHEDULE_ROW", "MISSING_CUTOFF"];

describe("the migration still contains the rule this test models", () => {
  const flat = SQL.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

  it("appends and nothing else - no UPDATE, no DELETE, no REPLACE", () => {
    assert.equal((flat.match(/INSERT INTO/g) || []).length, 1);
    assert.ok(!/UPDATE\s+`?employee_work_shift_assignment/i.test(flat));
    assert.ok(!/DELETE\s+FROM/i.test(flat));
    assert.ok(!/REPLACE\s+INTO/i.test(flat));
    assert.ok(!/ON DUPLICATE KEY UPDATE/i.test(flat));
  });

  it("only acts where the earliest row starts after the target date", () => {
    assert.match(flat, /WHERE g\.`earliest_from` > g\.`target_from`/);
  });

  it("requires punch evidence in the gap", () => {
    assert.match(flat, /biomax_punch_derived/);
    assert.match(flat, /'NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF'/);
    assert.match(flat, /p\.`punch_date` < g\.`earliest_from`/);
  });

  it("dates the appended row at GREATEST(cutover, joining date)", () => {
    assert.match(flat, /GREATEST\('2026-09-01', COALESCE\(CASE/);
  });

  it("reads the joining date through the one shared parser", () => {
    const { JOINED_ON } = require("../utils/joining_date");
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const canonical = norm(JOINED_ON("ne"));
    const inMigration = norm(/(CASE\s+WHEN ne\.date_of_joining IS NULL[\s\S]*?END)/.exec(
      SQL.replace(/--[^\n]*/g, "")
    )[1]);
    assert.equal(inMigration, canonical);
  });

  it("carries the EARLIEST row's shift, not new_employee.default_work_shift_id", () => {
    assert.match(flat, /SUBSTRING_INDEX\( GROUP_CONCAT\(a\.`work_shift_id`/);
    assert.ok(
      !/default_work_shift_id/.test(flat),
      "current state may since have moved on; the earliest known shift is the honest answer"
    );
  });
});

/* ------------------------------------------- the semantics, executed */

const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
function joinedOn(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const t = String(raw).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const long = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(t);
  if (long && MONTHS[long[2].toLowerCase()]) {
    return `${long[3]}-${String(MONTHS[long[2].toLowerCase()]).padStart(2,"0")}-${long[1].padStart(2,"0")}`;
  }
  return null;
}

/** One run of the repair over in-memory rows. Returns the rows it appended. */
function runRepair(world) {
  const added = [];
  for (const employee of world.employees) {
    const rows = world.assignments
      .filter((a) => a.employee_id === employee.employee_id)
      .sort((x, y) =>
        x.effective_from.localeCompare(y.effective_from) ||
        x.employee_work_shift_assignment_id - y.employee_work_shift_assignment_id
      );
    if (rows.length === 0) continue;                       // the FIRST repair's job
    const earliestFrom = rows[0].effective_from;
    const earliestShift = rows[0].work_shift_id;
    const parsed = joinedOn(employee.date_of_joining) || CUTOVER;
    const targetFrom = parsed > CUTOVER ? parsed : CUTOVER;
    if (!(earliestFrom > targetFrom)) continue;
    const hasEvidence = world.punches.some(
      (p) =>
        p.employee_id === employee.employee_id &&
        UNDATABLE.includes(p.derivation_status) &&
        p.punch_date < earliestFrom
    );
    if (!hasEvidence) continue;
    const row = {
      employee_work_shift_assignment_id: world.nextId++,
      employee_id: employee.employee_id,
      work_shift_id: earliestShift,
      effective_from: targetFrom,
      source: "MIGRATION_BACKFILL",
    };
    world.assignments.push(row);
    added.push(row);
  }
  return added;
}

const world = (employees, assignments = [], punches = []) => ({
  employees,
  assignments: assignments.map((a, i) => ({ employee_work_shift_assignment_id: i + 1, ...a })),
  punches,
  nextId: assignments.length + 1,
});
const rowsFor = (w, id) => w.assignments.filter((a) => a.employee_id === id);

describe("the production case", () => {
  /** Shift assigned on the 12th; seventeen undatable punches from the 2nd to the 10th. */
  const employee1865 = () =>
    world(
      [{ employee_id: 1865, default_work_shift_id: 7, date_of_joining: "2026-08-01" }],
      [{ employee_id: 1865, work_shift_id: 7, effective_from: "2026-09-12", source: "ASSIGNMENT" }],
      ["02","03","04","05","08","09","10"].map((d) => ({
        employee_id: 1865,
        punch_date: `2026-09-${d}`,
        derivation_status: "NO_SHIFT",
      }))
    );

  it("before the repair, every punch date resolves to nothing", () => {
    const w = employee1865();
    for (const p of w.punches) {
      assert.equal(resolveAssignmentForDate(rowsFor(w, 1865), p.punch_date), null, p.punch_date);
    }
  });

  it("the repair appends exactly one row, at the cutover, on the earliest known shift", () => {
    const w = employee1865();
    const added = runRepair(w);
    assert.equal(added.length, 1);
    assert.equal(added[0].effective_from, CUTOVER);
    assert.equal(added[0].work_shift_id, 7);
    assert.equal(rowsFor(w, 1865).length, 2);
  });

  it("and afterwards every punch date resolves to the shift", () => {
    const w = employee1865();
    runRepair(w);
    for (const p of w.punches) {
      const hit = resolveAssignmentForDate(rowsFor(w, 1865), p.punch_date);
      assert.ok(hit, `${p.punch_date} still unresolved`);
      assert.equal(hit.work_shift_id, 7);
    }
  });

  it("the later assignment row is untouched and still wins from its own date", () => {
    const w = employee1865();
    runRepair(w);
    const original = rowsFor(w, 1865).find((r) => r.effective_from === "2026-09-12");
    assert.equal(original.source, "ASSIGNMENT", "the original row is not rewritten");
    assert.equal(resolveAssignmentForDate(rowsFor(w, 1865), "2026-09-20").work_shift_id, 7);
  });
});

describe("what it must not do", () => {
  it("NEVER changes a date from one shift to a DIFFERENT shift - only nothing -> a shift", () => {
    // The single most important property. The appended row is by
    // construction the new earliest, so every date the employee already
    // resolved keeps the answer it had.
    const w = world(
      [{ employee_id: 300, default_work_shift_id: 2, date_of_joining: "2026-08-01" }],
      [
        { employee_id: 300, work_shift_id: 1, effective_from: "2026-09-15", source: "ASSIGNMENT" },
        { employee_id: 300, work_shift_id: 2, effective_from: "2026-09-25", source: "ASSIGNMENT" },
      ],
      [{ employee_id: 300, punch_date: "2026-09-03", derivation_status: "NO_SHIFT" }]
    );
    const dates = [];
    for (let d = 1; d <= 30; d += 1) dates.push(`2026-09-${String(d).padStart(2, "0")}`);
    const before = dates.map((d) => {
      const hit = resolveAssignmentForDate(rowsFor(w, 300), d);
      return hit ? hit.work_shift_id : null;
    });

    runRepair(w);

    const after = dates.map((d) => {
      const hit = resolveAssignmentForDate(rowsFor(w, 300), d);
      return hit ? hit.work_shift_id : null;
    });
    dates.forEach((d, i) => {
      if (before[i] === null) {
        assert.equal(after[i], 1, `${d} should now resolve to the earliest known shift`);
      } else {
        assert.equal(after[i], before[i], `${d} changed from ${before[i]} to ${after[i]}`);
      }
    });
  });

  it("leaves alone an employee with no punch evidence in the gap", () => {
    const w = world(
      [{ employee_id: 400, default_work_shift_id: 7, date_of_joining: "2026-08-01" }],
      [{ employee_id: 400, work_shift_id: 7, effective_from: "2026-09-12", source: "ASSIGNMENT" }],
      []
    );
    assert.deepEqual(runRepair(w), []);
  });

  it("leaves alone an employee whose punches in the gap were dated fine", () => {
    const w = world(
      [{ employee_id: 401, default_work_shift_id: 7, date_of_joining: "2026-08-01" }],
      [{ employee_id: 401, work_shift_id: 7, effective_from: "2026-09-12", source: "ASSIGNMENT" }],
      [{ employee_id: 401, punch_date: "2026-09-03", derivation_status: "OK" }]
    );
    assert.deepEqual(runRepair(w), []);
  });

  it("leaves alone an employee whose history already starts at the target", () => {
    const w = world(
      [{ employee_id: 402, default_work_shift_id: 7, date_of_joining: "2026-08-01" }],
      [{ employee_id: 402, work_shift_id: 7, effective_from: CUTOVER, source: "MIGRATION_BACKFILL" }],
      [{ employee_id: 402, punch_date: "2026-09-03", derivation_status: "NO_SHIFT" }]
    );
    assert.deepEqual(runRepair(w), []);
  });

  it("does not touch an employee with NO history - that is the first repair's job", () => {
    const w = world(
      [{ employee_id: 403, default_work_shift_id: 7, date_of_joining: "2026-08-01" }],
      [],
      [{ employee_id: 403, punch_date: "2026-09-03", derivation_status: "NO_SHIFT" }]
    );
    assert.deepEqual(runRepair(w), []);
  });

  it("never dates a row before the cutover or before the employee joined", () => {
    for (const [joined, expected] of [
      ["2026-08-01", CUTOVER],
      ["2019-01-01", CUTOVER],
      ["2026-09-05", "2026-09-05"],
      [null, CUTOVER],
      ["05 September 2026", "2026-09-05"],
    ]) {
      const w = world(
        [{ employee_id: 500, default_work_shift_id: 7, date_of_joining: joined }],
        [{ employee_id: 500, work_shift_id: 7, effective_from: "2026-09-20", source: "ASSIGNMENT" }],
        [{ employee_id: 500, punch_date: "2026-09-10", derivation_status: "NO_SHIFT" }]
      );
      const added = runRepair(w);
      assert.equal(added.length, 1, `joined ${joined}`);
      assert.equal(added[0].effective_from, expected, `joined ${joined}`);
      assert.ok(added[0].effective_from >= CUTOVER);
    }
  });

  it("is idempotent - a second and third run insert nothing", () => {
    const w = world(
      [{ employee_id: 600, default_work_shift_id: 7, date_of_joining: "2026-08-01" }],
      [{ employee_id: 600, work_shift_id: 7, effective_from: "2026-09-12", source: "ASSIGNMENT" }],
      [{ employee_id: 600, punch_date: "2026-09-03", derivation_status: "NO_SHIFT" }]
    );
    assert.equal(runRepair(w).length, 1);
    const afterFirst = JSON.parse(JSON.stringify(w.assignments));
    assert.deepEqual(runRepair(w), []);
    assert.deepEqual(runRepair(w), []);
    assert.deepEqual(w.assignments, afterFirst);
  });

  it("gives each affected employee exactly one row, so nothing it writes can overlap", () => {
    const w = world(
      [
        { employee_id: 701, default_work_shift_id: 7, date_of_joining: "2026-08-01" },
        { employee_id: 702, default_work_shift_id: 8, date_of_joining: "2026-09-06" },
      ],
      [
        { employee_id: 701, work_shift_id: 7, effective_from: "2026-09-12", source: "ASSIGNMENT" },
        { employee_id: 702, work_shift_id: 8, effective_from: "2026-09-18", source: "ASSIGNMENT" },
      ],
      [
        { employee_id: 701, punch_date: "2026-09-03", derivation_status: "NO_SHIFT" },
        { employee_id: 702, punch_date: "2026-09-09", derivation_status: "NO_SHIFT" },
      ]
    );
    const added = runRepair(w);
    assert.equal(added.length, 2);
    const perEmployee = new Map();
    added.forEach((a) => perEmployee.set(a.employee_id, (perEmployee.get(a.employee_id) || 0) + 1));
    for (const [id, n] of perEmployee) assert.equal(n, 1, `employee ${id}`);
    assert.equal(rowsFor(w, 702).find((r) => r.source === "MIGRATION_BACKFILL").effective_from, "2026-09-06");
  });
});
