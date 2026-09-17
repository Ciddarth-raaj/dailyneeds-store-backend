/**
 * THE APPROVER SETUP DASHBOARD - the SQL behind the three counts, the
 * status filter and the row order.
 *
 *   node --test repository/attendance_approver_dashboard.test.js
 *
 * What these hold, all of which are easy to get subtly wrong in SQL:
 *
 *   EXEMPT EMPLOYEES ARE OUT, everywhere - list, count and summary - on the
 *   ONE existing flag (`new_employee.attendance_required`), read the way
 *   `utils/attendance_eligibility.js` reads it. No second exemption flag.
 *
 *   COMPLETED IS "ACTIVE MAPPING + FINAL APPROVER". First and Second Level
 *   are optional and must not appear in the predicate at all; a chain of
 *   Final alone is complete.
 *
 *   THE MAPPING JOIN STAYS A LEFT JOIN. Moving `s.is_active = 1` into the
 *   WHERE would make it an inner join and drop every employee with no
 *   mapping - the exact people the "Without Approver Setup" card is for.
 *
 *   THE SUMMARY IGNORES setup_status, so clicking a card narrows the table
 *   without redrawing the cards as "missing = everything".
 *
 *   THE ORDER IS NUMERIC on employee_id: 1, 2, 101 - not 1, 101, 2.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildSetupRepo = require("./attendance_approver_setup");

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

function fakeDb(answers = () => []) {
  const log = [];
  return {
    log,
    db: {
      query: (sql, params, cb) => {
        const done = typeof params === "function" ? params : cb;
        const args = typeof params === "function" ? [] : params;
        log.push({ sql: norm(sql), params: args });
        done(null, answers(norm(sql), args));
      },
    },
  };
}

const TODAY = "2026-09-17";
const ATTENDANCE_REQUIRED_SQL = /COALESCE\(ne\.attendance_required, 1\) = 1/;
const RESIGNATION_SQL = /ne\.resignation_date IS NULL OR ne\.resignation_date >= \?/;
const JOINING_SQL = /IS NULL OR \(\s*CASE WHEN ne\.date_of_joining/;
const COMPLETED_SQL =
  /\(s\.attendance_approver_setup_id IS NOT NULL AND s\.final_approver_employee_id IS NOT NULL\)/;

describe("the attendance-required scope", () => {
  it("scopes the LIST to employees who CURRENTLY require attendance", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listEmployeesWithSetup({ today: TODAY });
    assert.match(log[0].sql, ATTENDANCE_REQUIRED_SQL);
    assert.match(log[0].sql, RESIGNATION_SQL);
    assert.match(log[0].sql, JOINING_SQL);
  });

  it("does NOT use ne.status as the employment test", async () => {
    // The canonical helper says plainly that `status` is maintained by hand
    // and left at 1 for most leavers: reading it would admit people who left
    // years ago and could drop somebody still here whose status was never
    // set. Only the dated facts decide.
    const { db, log } = fakeDb(() => [{}]);
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({ today: TODAY });
    await repo.countEmployeesWithSetup({ today: TODAY });
    await repo.summariseEmployeesWithSetup({ today: TODAY });
    for (const { sql } of log) {
      const where = (sql.split("WHERE")[1] || "").split("ORDER BY")[0];
      assert.ok(!/ne\.status/.test(where), `status must not scope the population: ${where}`);
    }
  });

  it("binds the SAME business date to the list, the count and the summary", async () => {
    // A list and a summary that straddled midnight would describe two
    // different populations and the cards would stop adding up.
    const { db, log } = fakeDb(() => [{ attendance_required: 1, completed: 1, missing: 0 }]);
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({ today: TODAY });
    await repo.countEmployeesWithSetup({ today: TODAY });
    await repo.summariseEmployeesWithSetup({ today: TODAY });
    for (const { params } of log) {
      assert.deepEqual(params.slice(0, 2), [TODAY, TODAY], "one business date, bound twice");
    }
  });

  it("scopes the COUNT and the SUMMARY the same way", async () => {
    const { db, log } = fakeDb(() => [{ attendance_required: 0, completed: 0, missing: 0 }]);
    const repo = buildSetupRepo(db);
    await repo.countEmployeesWithSetup({ today: TODAY });
    await repo.summariseEmployeesWithSetup({ today: TODAY });
    assert.match(log[0].sql, ATTENDANCE_REQUIRED_SQL);
    assert.match(log[1].sql, ATTENDANCE_REQUIRED_SQL);
  });

  it("uses the EXISTING flag and invents no second one", async () => {
    const { db, log } = fakeDb(() => [{}]);
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({ today: TODAY });
    await repo.summariseEmployeesWithSetup({ today: TODAY });
    for (const { sql } of log) {
      assert.ok(
        !/attendance_exempt|requires_attendance|is_attendance|exempt_from/i.test(sql),
        `no second exemption flag: ${sql}`
      );
    }
  });
});

describe("the summary counts", () => {
  it("counts required, completed and missing in ONE database query", async () => {
    const { db, log } = fakeDb(() => [{ attendance_required: 200, completed: 185, missing: 15 }]);
    const summary = await buildSetupRepo(db).summariseEmployeesWithSetup({ today: TODAY });

    assert.equal(log.length, 1, "one round trip, not one per card");
    assert.deepEqual(summary, { attendance_required: 200, completed: 185, missing: 15 });
    assert.match(log[0].sql, /COUNT\(\*\) AS attendance_required/);
    assert.match(log[0].sql, COMPLETED_SQL);
  });

  it("splits every counted row into exactly one of completed or missing", async () => {
    // completed + missing = attendance_required is the invariant the cards
    // are read against, and it holds by construction: the two CASEs are each
    // other's complement over the same COUNT(*).
    const { db, log } = fakeDb(() => [{ attendance_required: 7, completed: 3, missing: 4 }]);
    const summary = await buildSetupRepo(db).summariseEmployeesWithSetup({ today: TODAY });

    assert.equal(summary.completed + summary.missing, summary.attendance_required);
    assert.match(log[0].sql, /SUM\(CASE WHEN .* THEN 1 ELSE 0 END\) AS completed/);
    assert.match(log[0].sql, /SUM\(CASE WHEN .* THEN 0 ELSE 1 END\) AS missing/);
  });

  it("applies Department / Store / Designation / Employee / Search to the counts", async () => {
    const { db, log } = fakeDb(() => [{ attendance_required: 1, completed: 1, missing: 0 }]);
    await buildSetupRepo(db).summariseEmployeesWithSetup({
      today: TODAY,
      department_id: 2,
      store_id: 3,
      designation_id: 5,
      employee_id: 7,
      search: "raj",
    });

    // The same predicates the table's own rows are filtered by, so the cards
    // describe the population the table is showing.
    assert.match(log[0].sql, /ne\.department_id = \? AND ne\.store_id = \? AND ne\.designation_id = \? AND ne\.employee_id = \?/);
    // The eligibility predicate leads, so its two dates lead the params.
    assert.deepEqual(log[0].params, [TODAY, TODAY, 2, 3, 5, 7, "%raj%", "%raj%"]);
  });

  it("IGNORES setup_status, so a selected card does not redraw the cards", async () => {
    const { db, log } = fakeDb(() => [{ attendance_required: 200, completed: 185, missing: 15 }]);
    const repo = buildSetupRepo(db);

    await repo.summariseEmployeesWithSetup({ today: TODAY, setup_status: "missing" });
    await repo.summariseEmployeesWithSetup({ today: TODAY, setup_status: "completed" });

    // Neither summary carries the row filter: both are the full split.
    for (const { sql } of log) {
      const where = sql.split("WHERE")[1] || "";
      assert.ok(!/NOT \(s\.attendance_approver_setup_id/.test(where), "missing filter leaked into the summary");
      assert.equal(
        (where.match(/s\.attendance_approver_setup_id IS NOT NULL/g) || []).length,
        0,
        "completed filter leaked into the summary"
      );
    }
  });

  it("reads a missing or non-numeric answer as zero rather than NaN", async () => {
    const { db } = fakeDb(() => []);
    assert.deepEqual(await buildSetupRepo(db).summariseEmployeesWithSetup({ today: TODAY }), {
      attendance_required: 0,
      completed: 0,
      missing: 0,
    });
  });
});

describe("the setup_status row filter", () => {
  const whereOf = (log) => (log[0].sql.split("WHERE")[1] || "").split("ORDER BY")[0];

  it("completed means an ACTIVE mapping carrying a final approver", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listEmployeesWithSetup({ today: TODAY, setup_status: "completed" });
    assert.match(whereOf(log), COMPLETED_SQL);
  });

  it("missing is its exact complement", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listEmployeesWithSetup({ today: TODAY, setup_status: "missing" });
    assert.match(whereOf(log), /NOT \(s\.attendance_approver_setup_id IS NOT NULL AND s\.final_approver_employee_id IS NOT NULL\)/);
  });

  it("never consults the OPTIONAL first and second level approvers", async () => {
    // A chain of Final alone is complete. If either optional level ever
    // enters this predicate, three of the four valid shapes stop counting.
    const { db, log } = fakeDb();
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({ today: TODAY, setup_status: "completed" });
    await repo.listEmployeesWithSetup({ today: TODAY, setup_status: "missing" });

    for (const entry of log) {
      const where = (entry.sql.split("WHERE")[1] || "").split("ORDER BY")[0];
      assert.ok(!/first_level_approver_employee_id/.test(where), "first level must not decide completion");
      assert.ok(!/second_level_approver_employee_id/.test(where), "second level must not decide completion");
    }
  });

  it("keeps the mapping join a LEFT JOIN, so employees with no mapping are still listed", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listEmployeesWithSetup({ today: TODAY, setup_status: "missing" });
    assert.match(
      log[0].sql,
      /LEFT JOIN attendance_approver_setup s ON s\.employee_id = ne\.employee_id AND s\.is_active = 1/
    );
    const where = (log[0].sql.split("WHERE")[1] || "").split("ORDER BY")[0];
    assert.ok(!/s\.is_active/.test(where), "is_active in WHERE would make it an inner join");
  });

  it("combines with every other filter rather than replacing them", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listEmployeesWithSetup({
      setup_status: "missing",
      department_id: 2,
      search: "raj",
    });
    const where = whereOf(log);
    assert.match(where, ATTENDANCE_REQUIRED_SQL);
    assert.match(where, /ne\.department_id = \?/);
    assert.match(where, /ne\.employee_name LIKE \?/);
    assert.match(where, /NOT \(s\.attendance_approver_setup_id/);
  });

  it("an absent or unknown status filters nothing", async () => {
    const { db, log } = fakeDb();
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({ today: TODAY });
    await repo.listEmployeesWithSetup({ today: TODAY, setup_status: "nonsense" });
    for (const entry of log) {
      const where = (entry.sql.split("WHERE")[1] || "").split("ORDER BY")[0];
      assert.ok(!/attendance_approver_setup_id IS NOT NULL/.test(where));
    }
  });
});

describe("the main table's order", () => {
  it("orders by employee id NUMERICALLY, not by name", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listEmployeesWithSetup({ today: TODAY });
    assert.match(log[0].sql, /ORDER BY ne\.employee_id ASC/);
    assert.ok(!/ORDER BY ne\.employee_name/.test(log[0].sql), "name is no longer the primary sort");
    // employee_id is INT (migration 20210901160746), so no CAST is needed and
    // none must creep in - CAST(... AS CHAR) would sort 1, 101, 106, 2.
    assert.ok(
      !/ORDER BY[^`]*CAST\(ne\.employee_id/.test(log[0].sql),
      "a CAST in the ORDER BY would sort lexicographically"
    );
  });

  it("leaves the approver PICKER sorted by name", async () => {
    // Deliberately unchanged: the picker is searched by person.
    const { db, log } = fakeDb();
    await buildSetupRepo(db).listApproverOptions({});
    assert.match(log[0].sql, /ORDER BY ne\.status DESC, ne\.employee_name ASC/);
  });
});
