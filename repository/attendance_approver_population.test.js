/**
 * THE DASHBOARD POPULATION, proved against a real SQL engine.
 *
 *   node --test repository/attendance_approver_population.test.js
 *
 * The sibling files assert the SHAPE of the statements. This one runs the
 * actual predicate over actual rows in an in-memory SQL engine, because the
 * questions that matter here are not "is the clause present" but "does a
 * resigned employee whose status was never updated come back in the results".
 * A regex cannot answer that; only evaluation can.
 *
 * The engine is node:sqlite, so the MySQL-only parts of the predicate
 * (`JOINED_ON`'s STR_TO_DATE, DATE_FORMAT) are translated once, here, into
 * their SQLite equivalents for the ISO shape - and the translation is
 * deliberately NARROW: it rewrites the date parsing and nothing else, so the
 * boolean logic under test is the production logic, character for character.
 *
 * If node:sqlite is unavailable the file skips rather than passing silently.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  currentlyAttendanceEligible,
  currentlyAttendanceEligibleParams,
} = require("../utils/attendance_eligibility_sql");
const { eligibleOn } = require("../utils/attendance_eligibility");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_) {
  /* older runtime: the suite skips below */
}

const TODAY = "2026-09-17";

/**
 * The production predicate with ONLY its date parsing rewritten for SQLite.
 * `JOINED_ON` handles three shapes in MySQL; these fixtures use the ISO one
 * and the empty one, which is what `date(...)` covers.
 */
function sqlitePredicate() {
  const { clause } = currentlyAttendanceEligible("ne");
  // Global: JOINED_ON appears TWICE in the clause (the IS NULL test and the
  // comparison), and a non-global replace would leave the second one as
  // MySQL and fail on STR_TO_DATE.
  return clause.replace(
    /CASE[\s\S]*?END/g,
    `CASE
       WHEN ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '' THEN NULL
       ELSE date(substr(ne.date_of_joining, 1, 10))
     END`
  );
}

/** id, name, status, attendance_required, date_of_joining, resignation_date */
const PEOPLE = [
  { employee_id: 1, employee_name: "Currently eligible", status: 1, attendance_required: 1, date_of_joining: "2024-01-01", resignation_date: null },
  { employee_id: 2, employee_name: "Attendance exempt", status: 1, attendance_required: 0, date_of_joining: "2024-01-01", resignation_date: null },
  { employee_id: 3, employee_name: "Joins in December", status: 1, attendance_required: 1, date_of_joining: "2026-12-01", resignation_date: null },
  // The case `status = 1` gets wrong: left in March, status never updated.
  { employee_id: 4, employee_name: "Resigned, stale status", status: 1, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: "2025-03-31" },
  { employee_id: 5, employee_name: "Joining date unreadable", status: 1, attendance_required: 1, date_of_joining: "", resignation_date: null },
  // status 0 but no resignation date: the dated facts say they are still here.
  { employee_id: 6, employee_name: "Status zero, still here", status: 0, attendance_required: 1, date_of_joining: "2023-06-01", resignation_date: null },
  { employee_id: 7, employee_name: "Leaves today", status: 1, attendance_required: 1, date_of_joining: "2021-01-01", resignation_date: TODAY },
  { employee_id: 8, employee_name: "Joins today", status: 1, attendance_required: 1, date_of_joining: TODAY, resignation_date: null },
];

/** employee_id -> an ACTIVE setup with a final approver (completed). */
const COMPLETED_FOR = [1, 4];

let db = null;

describe("the currently-attendance-eligible population", { skip: !DatabaseSync && "node:sqlite unavailable" }, () => {
  before(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE new_employee (
      employee_id INTEGER PRIMARY KEY, employee_name TEXT, status INTEGER,
      attendance_required INTEGER, date_of_joining TEXT, resignation_date TEXT)`);
    db.exec(`CREATE TABLE attendance_approver_setup (
      attendance_approver_setup_id INTEGER PRIMARY KEY, employee_id INTEGER,
      final_approver_employee_id INTEGER, is_active INTEGER)`);
    const ins = db.prepare(
      "INSERT INTO new_employee VALUES (?, ?, ?, ?, ?, ?)"
    );
    PEOPLE.forEach((p) =>
      ins.run(p.employee_id, p.employee_name, p.status, p.attendance_required, p.date_of_joining, p.resignation_date)
    );
    const insSetup = db.prepare(
      "INSERT INTO attendance_approver_setup VALUES (?, ?, ?, 1)"
    );
    COMPLETED_FOR.forEach((id, i) => insSetup.run(i + 1, id, 900));
  });

  const SETUP_JOIN = `LEFT JOIN attendance_approver_setup s
                        ON s.employee_id = ne.employee_id AND s.is_active = 1`;
  const COMPLETED = `(s.attendance_approver_setup_id IS NOT NULL
                      AND s.final_approver_employee_id IS NOT NULL)`;

  const listed = (extraWhere = "") =>
    db
      .prepare(
        `SELECT ne.employee_id FROM new_employee ne ${SETUP_JOIN}
          WHERE ${sqlitePredicate()} ${extraWhere}
          ORDER BY ne.employee_id ASC`
      )
      .all(...currentlyAttendanceEligibleParams(TODAY))
      .map((r) => r.employee_id);

  const summary = () =>
    db
      .prepare(
        `SELECT COUNT(*) AS attendance_required,
                SUM(CASE WHEN ${COMPLETED} THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN ${COMPLETED} THEN 0 ELSE 1 END) AS missing
           FROM new_employee ne ${SETUP_JOIN}
          WHERE ${sqlitePredicate()}`
      )
      .get(...currentlyAttendanceEligibleParams(TODAY));

  it("1. excludes an attendance-exempt employee", () => {
    assert.ok(!listed().includes(2));
  });

  it("2. excludes an employee whose joining date is in the future", () => {
    assert.ok(!listed().includes(3));
  });

  it("3 & 5. excludes an employee who resigned before today, stale status = 1 and all", () => {
    assert.ok(!listed().includes(4), "status = 1 must not readmit a leaver");
  });

  it("4. includes a currently employed, attendance-required employee", () => {
    assert.ok(listed().includes(1));
  });

  it("includes an employee whose joining date is unreadable, and one whose status is 0", () => {
    const ids = listed();
    // An absent bound is unbounded in the canonical helper - 425 of 630
    // production rows carry no readable joining date.
    assert.ok(ids.includes(5), "unreadable joining date must not exclude");
    // `status` is not the employment test; no resignation date means here.
    assert.ok(ids.includes(6), "status 0 with no resignation date is still employed");
  });

  it("includes the boundary days: joining today and leaving today", () => {
    const ids = listed();
    assert.ok(ids.includes(7), "resignation date == today is still in");
    assert.ok(ids.includes(8), "joining date == today is already in");
  });

  it("agrees, row for row, with the JS helper it mirrors", () => {
    // The two implementations of one rule, compared on the same fixtures.
    const fromSql = new Set(listed());
    const fromHelper = PEOPLE.filter((p) => eligibleOn(p, TODAY)).map((p) => p.employee_id);
    assert.deepEqual([...fromSql].sort((a, b) => a - b), fromHelper.sort((a, b) => a - b));
  });

  it("6 & 7. the summary excludes resigned stale-status employees and future joiners", () => {
    const s = summary();
    // 8 people, minus exempt, minus future joiner, minus the leaver = 5.
    assert.equal(s.attendance_required, 5);
    // Employee 4 has a completed setup but has left: it must not be counted.
    assert.equal(s.completed, 1, "only the eligible employee's completed setup counts");
  });

  it("8. completed + missing = the currently attendance-eligible total", () => {
    const s = summary();
    assert.equal(s.completed + s.missing, s.attendance_required);
    assert.equal(s.attendance_required, listed().length, "and it is the same population the table lists");
  });

  it("9. setup_status=missing excludes ineligible employees", () => {
    const ids = listed(`AND NOT ${COMPLETED}`);
    assert.deepEqual(ids, [5, 6, 7, 8]);
    for (const ineligible of [2, 3, 4]) {
      assert.ok(!ids.includes(ineligible), `${ineligible} must never appear as missing`);
    }
  });

  it("10. setup_status=completed excludes ineligible employees", () => {
    const ids = listed(`AND ${COMPLETED}`);
    assert.deepEqual(ids, [1]);
    assert.ok(!ids.includes(4), "a departed employee's old mapping is not 'completed' work");
  });

  it("the two status filters partition the population exactly", () => {
    const all = listed();
    const completed = listed(`AND ${COMPLETED}`);
    const missing = listed(`AND NOT ${COMPLETED}`);
    assert.equal(completed.length + missing.length, all.length);
    assert.deepEqual([...completed, ...missing].sort((a, b) => a - b), all);
  });
});
