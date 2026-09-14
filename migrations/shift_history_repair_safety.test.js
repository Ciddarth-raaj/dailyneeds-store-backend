/**
 * The shift-history repair backfill: what it must NOT do.
 *
 *   node --test migrations/shift_history_repair_safety.test.js
 *
 * There is no MySQL here, so the INSERT ... SELECT is parsed out of the
 * migration and its semantics are executed against in-memory rows. That is
 * weaker than running it, and it is chosen deliberately over asserting on
 * the SQL text: the questions worth answering about this migration are
 * behavioural - "does it touch an employee who already has history", "does a
 * second run insert anything" - and a regex over the statement cannot answer
 * either.
 *
 * WHAT IS ACTUALLY SIMULATED. The three clauses that decide the outcome, read
 * from the file so the test fails if any of them is edited:
 *
 *   WHERE default_work_shift_id IS NOT NULL
 *   AND   NOT EXISTS (any assignment row for this employee)
 *   SET   effective_from = GREATEST(cutover, JOINED_ON(...))
 *
 * The parser below asserts each clause is present before relying on it, so
 * the simulation cannot quietly pass against a migration that no longer
 * contains the rule it is modelling.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20260930120000-attendance-required-and-shift-history-repair";
const SQL = fs.readFileSync(
  path.join(__dirname, "mysql/migrations/sqls", `${NAME}-up.sql`),
  "utf8"
);
const CUTOVER = "2026-09-01";

/* -------------------------------- the clauses, read out of the migration */

const insert = (() => {
  const start = SQL.indexOf("INSERT INTO `employee_work_shift_assignment`");
  assert.notEqual(start, -1, "the repair INSERT is gone");
  return SQL.slice(start, SQL.indexOf(";", start));
})();

describe("the migration still contains the rule this test models", () => {
  it("inserts only for employees with a default work shift", () => {
    assert.match(insert, /ne\.`default_work_shift_id` IS NOT NULL/);
  });

  it("guards per EMPLOYEE, not per row - any existing history skips them entirely", () => {
    assert.match(
      insert.replace(/\s+/g, " "),
      /NOT EXISTS \( SELECT 1 FROM `employee_work_shift_assignment` a WHERE a\.`employee_id` = ne\.`employee_id` \)/
    );
  });

  it("dates the row at the LATER of the cutover and the joining date", () => {
    assert.match(insert.replace(/\s+/g, " "), /GREATEST\( '2026-09-01', COALESCE\(/);
  });

  it("reads the joining date through the ONE shared parser, character for character", () => {
    // `date_of_joining` is a VARCHAR in three shapes. A bare
    // STR_TO_DATE(..., '%Y-%m-%d') returns NULL for two of them and would
    // quietly date a genuine October joiner at the cutover.
    const { JOINED_ON } = require("../utils/joining_date");
    const flat = (s) => s.replace(/\s+/g, " ").trim();
    const canonical = flat(JOINED_ON("ne"));
    const inMigration = flat(/(CASE\s+WHEN ne\.date_of_joining IS NULL[\s\S]*?END)/.exec(insert)[1]);
    assert.equal(inMigration, canonical);
  });

  it("never UPDATEs or DELETEs assignment history anywhere in the file", () => {
    const body = SQL.replace(/--[^\n]*/g, "");
    assert.ok(!/UPDATE\s+`employee_work_shift_assignment`/i.test(body));
    assert.ok(!/DELETE\s+FROM\s+`employee_work_shift_assignment`/i.test(body));
    assert.ok(!/INSERT\s+.*ON DUPLICATE KEY UPDATE/i.test(body));
    assert.ok(!/REPLACE\s+INTO/i.test(body));
  });
});

/* ------------------------------------------ the semantics, executed */

/** `JOINED_ON`: ISO prefix, Indian long form, else NULL. */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
function joinedOn(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const long = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text);
  if (long && MONTHS[long[2].toLowerCase()]) {
    return `${long[3]}-${String(MONTHS[long[2].toLowerCase()]).padStart(2, "0")}-${long[1].padStart(2, "0")}`;
  }
  return null;
}

/** One run of the INSERT ... SELECT over in-memory rows. Returns rows added. */
function runMigration(world) {
  const added = [];
  for (const employee of world.employees) {
    if (employee.default_work_shift_id === null || employee.default_work_shift_id === undefined) continue;
    if (world.assignments.some((a) => a.employee_id === employee.employee_id)) continue;
    const parsed = joinedOn(employee.date_of_joining) || CUTOVER;
    const row = {
      employee_work_shift_assignment_id: world.nextId++,
      employee_id: employee.employee_id,
      work_shift_id: employee.default_work_shift_id,
      effective_from: parsed > CUTOVER ? parsed : CUTOVER,
      source: "MIGRATION_BACKFILL",
    };
    world.assignments.push(row);
    added.push(row);
  }
  return added;
}

const world = (employees, assignments = []) => ({
  employees,
  assignments: assignments.map((a, i) => ({ employee_work_shift_assignment_id: i + 1, ...a })),
  nextId: assignments.length + 1,
});

const forEmployee = (w, id) =>
  w.assignments.filter((a) => a.employee_id === id).sort((x, y) => x.effective_from.localeCompare(y.effective_from));

describe("the eight cases", () => {
  it("1. default shift, ZERO history -> exactly one row", () => {
    const w = world([{ employee_id: 2282, default_work_shift_id: 7, date_of_joining: "2026-09-20" }]);
    const added = runMigration(w);
    assert.equal(added.length, 1);
    assert.deepEqual(forEmployee(w, 2282).map((a) => [a.work_shift_id, a.effective_from]), [
      [7, "2026-09-20"],
    ]);
  });

  it("2. matching history already -> nothing written", () => {
    const w = world(
      [{ employee_id: 100, default_work_shift_id: 7, date_of_joining: "2026-09-20" }],
      [{ employee_id: 100, work_shift_id: 7, effective_from: "2026-09-20", source: "ASSIGNMENT" }]
    );
    const before = JSON.parse(JSON.stringify(w.assignments));
    assert.deepEqual(runMigration(w), []);
    assert.deepEqual(w.assignments, before, "existing history is untouched");
  });

  it("3. THE EXAMPLE: Shift A from April, Shift B from August -> both preserved, nothing added", () => {
    const w = world(
      [{ employee_id: 300, default_work_shift_id: 2 /* B, current */, date_of_joining: "2026-04-01" }],
      [
        { employee_id: 300, work_shift_id: 1, effective_from: "2026-04-01", source: "ASSIGNMENT" },
        { employee_id: 300, work_shift_id: 2, effective_from: "2026-08-01", source: "ASSIGNMENT" },
      ]
    );
    assert.deepEqual(runMigration(w), [], "no Shift A row is invented");
    assert.deepEqual(forEmployee(w, 300).map((a) => [a.work_shift_id, a.effective_from]), [
      [1, "2026-04-01"],
      [2, "2026-08-01"],
    ]);
    // And the later change still wins resolution, exactly as before.
    const { resolveAssignmentForDate } = require("../utils/shiftResolution");
    assert.equal(resolveAssignmentForDate(w.assignments, "2026-09-15").work_shift_id, 2);
    assert.equal(resolveAssignmentForDate(w.assignments, "2026-05-15").work_shift_id, 1);
  });

  it("4. overlapping / bad history already -> left exactly as found, not 'repaired'", () => {
    const messy = [
      { employee_id: 400, work_shift_id: 1, effective_from: "2026-09-01", source: "ASSIGNMENT" },
      { employee_id: 400, work_shift_id: 3, effective_from: "2026-09-01", source: "CORRECTION" },
      { employee_id: 400, work_shift_id: 2, effective_from: "2026-08-01", source: "CORRECTION" },
    ];
    const w = world([{ employee_id: 400, default_work_shift_id: 9, date_of_joining: "2026-01-01" }], messy);
    const before = JSON.parse(JSON.stringify(w.assignments));
    assert.deepEqual(runMigration(w), []);
    assert.deepEqual(w.assignments, before, "a mess is somebody's decision to fix, not a migration's");
  });

  it("5. no default shift -> no row, and 'unassigned' stays a real answer", () => {
    const w = world([{ employee_id: 500, default_work_shift_id: null, date_of_joining: "2026-09-20" }]);
    assert.deepEqual(runMigration(w), []);
    assert.deepEqual(forEmployee(w, 500), []);
  });

  it("6. joined AFTER the cutover -> dated at the joining date, not at the cutover", () => {
    const w = world([{ employee_id: 600, default_work_shift_id: 7, date_of_joining: "2026-10-05" }]);
    runMigration(w);
    assert.equal(forEmployee(w, 600)[0].effective_from, "2026-10-05");
  });

  it("7. joined BEFORE the cutover -> dated at the cutover, inventing no pre-v2 history", () => {
    for (const joined of ["2019-06-01", "2026-04-01", "05 September 2021", "", null]) {
      const w = world([{ employee_id: 700, default_work_shift_id: 7, date_of_joining: joined }]);
      runMigration(w);
      assert.equal(forEmployee(w, 700)[0].effective_from, CUTOVER, `joined ${joined}`);
    }
  });

  it("8. run TWICE -> the second run inserts nothing and changes nothing", () => {
    const w = world([
      { employee_id: 801, default_work_shift_id: 7, date_of_joining: "2026-10-05" },
      { employee_id: 802, default_work_shift_id: 8, date_of_joining: "2019-01-01" },
      { employee_id: 803, default_work_shift_id: null, date_of_joining: "2026-10-05" },
    ]);
    assert.equal(runMigration(w).length, 2);
    const afterFirst = JSON.parse(JSON.stringify(w.assignments));
    assert.deepEqual(runMigration(w), [], "second run");
    assert.deepEqual(runMigration(w), [], "third run");
    assert.deepEqual(w.assignments, afterFirst);
  });
});

describe("the properties that must hold whatever the data", () => {
  const population = [
    { employee_id: 1, default_work_shift_id: 7, date_of_joining: "2026-10-05" },
    { employee_id: 2, default_work_shift_id: 7, date_of_joining: "2019-01-01" },
    { employee_id: 3, default_work_shift_id: null, date_of_joining: "2026-10-05" },
    { employee_id: 4, default_work_shift_id: 8, date_of_joining: "05 September 2026" },
    { employee_id: 5, default_work_shift_id: 8, date_of_joining: null },
    { employee_id: 6, default_work_shift_id: 9, date_of_joining: "2026-09-20 00:00:00" },
  ];
  const existing = [
    { employee_id: 2, work_shift_id: 1, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
    { employee_id: 4, work_shift_id: 5, effective_from: "2026-09-10", source: "ASSIGNMENT" },
    { employee_id: 4, work_shift_id: 6, effective_from: "2026-10-01", source: "ASSIGNMENT" },
  ];

  it("writes at most ONE row per employee, so no row can overlap another it created", () => {
    const w = world(population, existing);
    const added = runMigration(w);
    const counts = new Map();
    added.forEach((a) => counts.set(a.employee_id, (counts.get(a.employee_id) || 0) + 1));
    for (const [id, n] of counts) assert.equal(n, 1, `employee ${id}`);
  });

  it("touches only employees who had NO history at all", () => {
    const w = world(population, existing);
    const hadHistory = new Set(existing.map((a) => a.employee_id));
    for (const row of runMigration(w)) {
      assert.ok(!hadHistory.has(row.employee_id), `employee ${row.employee_id} already had history`);
    }
  });

  it("never dates a row before the v2 cutover, and never before the employee joined", () => {
    const w = world(population, existing);
    for (const row of runMigration(w)) {
      assert.ok(row.effective_from >= CUTOVER, `${row.employee_id} predates the cutover`);
      const joined = joinedOn(population.find((e) => e.employee_id === row.employee_id).date_of_joining);
      if (joined) assert.ok(row.effective_from >= joined, `${row.employee_id} predates joining`);
    }
  });

  it("leaves shift resolution unambiguous for every employee afterwards", () => {
    const { resolveAssignmentForDate } = require("../utils/shiftResolution");
    const w = world(population, existing);
    runMigration(w);
    for (const employee of population) {
      const rows = forEmployee(w, employee.employee_id);
      for (const date of ["2026-09-15", "2026-10-15", "2026-12-31"]) {
        const winner = resolveAssignmentForDate(rows, date);
        // Resolution is total: exactly one winner, or a clean "no shift".
        if (rows.length === 0) assert.equal(winner, null, `${employee.employee_id} @ ${date}`);
        else if (winner) assert.ok(winner.work_shift_id, `${employee.employee_id} @ ${date}`);
      }
    }
  });

  it("claims no more history than A0's blanket cutover already did", () => {
    // Every row this writes is dated on or after the date A0 would have
    // used, so the repair can only ever be MORE conservative than the
    // migration it is completing - never less.
    const w = world(population, existing);
    for (const row of runMigration(w)) assert.ok(row.effective_from >= CUTOVER);
  });
});
