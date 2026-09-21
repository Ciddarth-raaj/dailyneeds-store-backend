/**
 * THE DATED FACTS A SHIFT RULE CHANGE PROPAGATES OVER, as queried.
 *
 *   node --test repository/shift_propagation_facts.test.js
 *
 * `utils/shift_propagation.js` decides the rule; what is asserted here is
 * that the repository HANDS IT everything the rule needs - in particular for
 * an employee it discovers through a single-date override alone. Such a
 * person has no assignment row, so employment facts taken from the assignment
 * query would reach the pure scope as `employee: null`, which the shared
 * eligibility helper reads as unbounded and attendance-required: somebody who
 * resigned in July would have July recalculated.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./attendance_calculation");

const ASSIGNED = 101; // has assignment history for the shift
const OVERRIDE_ONLY = 202; // reaches the shift only through a one-day override

function fakeDb() {
  const asked = [];
  return {
    asked,
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      asked.push({ sql: text, params });

      if (/UNION/.test(text) && /employee_work_shift_assignment/.test(text)) {
        return cb(null, [{ employee_id: ASSIGNED }, { employee_id: OVERRIDE_ONLY }]);
      }
      if (/FROM new_employee/.test(text)) {
        return cb(null, [
          {
            employee_id: ASSIGNED,
            employee_name: "Asha",
            attendance_required: 1,
            date_of_joining: "2020-01-01",
            resignation_date: null,
          },
          {
            employee_id: OVERRIDE_ONLY,
            employee_name: "Bala",
            attendance_required: 0,
            date_of_joining: "2026-09-10",
            resignation_date: "2026-09-18",
          },
        ]);
      }
      if (/FROM employee_work_shift_assignment a/.test(text)) {
        return cb(null, [
          {
            employee_work_shift_assignment_id: 1,
            employee_id: ASSIGNED,
            work_shift_id: 5,
            effective_from: "2026-09-01",
          },
        ]);
      }
      if (/FROM attendance_date_shift_override/.test(text)) {
        return cb(null, [{ employee_id: OVERRIDE_ONLY, attendance_date: "2026-09-15" }]);
      }
      if (/FROM payrun_employee_calculation/.test(text)) {
        return cb(null, [{ employee_id: ASSIGNED, period_year: 2026, period_month: 8 }]);
      }
      cb(null, []);
    },
  };
}

describe("listShiftPropagationFacts", () => {
  it("returns employment facts for EVERY discovered employee, assignment history or not", async () => {
    const db = fakeDb();
    const facts = await buildRepo(db).listShiftPropagationFacts(5);

    const overrideOnly = facts.find((f) => f.employee_id === OVERRIDE_ONLY);
    assert.ok(overrideOnly, "an override-only employee is discovered");
    assert.deepEqual(overrideOnly.assignments, [], "and has no assignment history at all");
    assert.deepEqual(
      overrideOnly.employee,
      {
        employee_id: OVERRIDE_ONLY,
        employee_name: "Bala",
        attendance_required: 0,
        date_of_joining: "2026-09-10",
        resignation_date: "2026-09-18",
      },
      "yet their employment bounds and exemption are present"
    );
    assert.deepEqual(overrideOnly.override_dates, ["2026-09-15"]);
  });

  it("employment is its own query, not a join onto the assignment history", async () => {
    const db = fakeDb();
    await buildRepo(db).listShiftPropagationFacts(5);

    const employment = db.asked.find((q) => /FROM new_employee/.test(q.sql));
    assert.ok(employment, "there is an employment query");
    assert.ok(
      !/JOIN new_employee/.test(db.asked.find((q) => /FROM employee_work_shift_assignment a/.test(q.sql)).sql),
      "and the assignment query no longer carries it"
    );
    assert.deepEqual(employment.params, [[ASSIGNED, OVERRIDE_ONLY]], "for every discovered id");
  });

  it("carries the assignment history and the locked months through", async () => {
    const facts = await buildRepo(fakeDb()).listShiftPropagationFacts(5);
    const assigned = facts.find((f) => f.employee_id === ASSIGNED);
    assert.equal(assigned.assignments.length, 1);
    assert.deepEqual(assigned.locked_months, ["2026-08"], "August is locked for this employee");
  });

  it("is a fixed number of statements, never one per employee", async () => {
    const db = fakeDb();
    await buildRepo(db).listShiftPropagationFacts(5);
    assert.equal(db.asked.length, 5, "ids, employment, assignments, overrides, locks");
  });
});
