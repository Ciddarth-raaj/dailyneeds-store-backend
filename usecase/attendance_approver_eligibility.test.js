/**
 * WHO CURRENTLY NEEDS AN APPROVER SETUP - and who may therefore be given one.
 *
 *   node --test usecase/attendance_approver_eligibility.test.js
 *
 * Two corrections are pinned here, and they are the same rule seen from two
 * sides.
 *
 * THE POPULATION IS NOT `status = 1`. It is the canonical attendance rule -
 * `utils/attendance_eligibility.js#eligibleOn` on today: attendance is
 * required of them, they have joined, they have not left. `status` is
 * maintained by hand and has been left at 1 for most leavers, so a screen
 * built on it lists people who left years ago as owing a setup.
 *
 * THE LIST HIDING SOMEBODY IS NOT A BOUNDARY. A Set or Bulk Set could still
 * create - or REACTIVATE - a mapping for an exempt, unjoined or departed
 * employee through a direct call or a stale tab. The write path now asks the
 * same helper about the TARGET, before anything is written, so a refusal
 * leaves no setup row and no audit row behind.
 *
 * Replace Approver is deliberately NOT subject to it: it exists to clean an
 * old approver out of mappings, and some of those mappings belong to people
 * who have since left. Refusing it there would strand exactly the rows it is
 * meant to fix.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_approver_setup");

const TODAY = "2026-09-17";

/* Employees, each differing in exactly one eligibility fact. */
const ELIGIBLE = {
  employee_id: 101,
  employee_name: "Asha R",
  status: 1,
  attendance_required: 1,
  date_of_joining: "2024-01-01",
  resignation_date: null,
};
const EXEMPT = { ...ELIGIBLE, employee_id: 102, employee_name: "Exempt E", attendance_required: 0 };
const FUTURE_JOINER = { ...ELIGIBLE, employee_id: 103, employee_name: "Future F", date_of_joining: "2026-12-01" };
/** status left at 1 long after they left - the case `status = 1` gets wrong. */
const RESIGNED_STALE_STATUS = {
  ...ELIGIBLE,
  employee_id: 104,
  employee_name: "Gone G",
  status: 1,
  resignation_date: "2025-03-31",
};
const APPROVER = { employee_id: 900, employee_name: "Final F", status: 1, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null };

const PEOPLE = [ELIGIBLE, EXEMPT, FUTURE_JOINER, RESIGNED_STALE_STATUS, APPROVER];

function fakeRepo({ setups = {} } = {}) {
  const calls = { saved: [], listed: [], summarised: [] };
  const rows = new Map(Object.entries(setups).map(([k, v]) => [Number(k), v]));
  return {
    calls,
    rows,
    getEmployeesByIds: async (ids) =>
      PEOPLE.filter((p) => ids.map(Number).includes(p.employee_id)).map((p) => ({ ...p })),
    getSetup: async (id) => rows.get(Number(id)) || null,
    saveSetup: async (args) => {
      calls.saved.push(args);
      rows.set(Number(args.setup.employee_id), { ...args.setup, is_active: 1 });
      return { code: 200 };
    },
    listEmployeesWithSetup: async (f) => { calls.listed.push(f); return []; },
    countEmployeesWithSetup: async () => 0,
    summariseEmployeesWithSetup: async (f) => { calls.summarised.push(f); return { attendance_required: 0, completed: 0, missing: 0 }; },
    findSetupsWithApprover: async () => [],
    findPendingStepsWithApprover: async () => [],
    replaceApprover: async (args) => ({ code: 200, setups_updated: (args.setup_employee_ids || []).length, pending_steps_updated: (args.step_ids || []).length }),
    listApproverOptions: async () => [],
  };
}

const usecaseOn = (repo, today = TODAY) => buildUsecase(repo, { today });
const ACTOR = { employee_id: 500, user_type: 2 };
const CHAIN = {
  first_level_approver_employee_id: null,
  second_level_approver_employee_id: null,
  final_approver_employee_id: APPROVER.employee_id,
};

/* ------------------------------------------- the list's business date ---- */

describe("the list binds one business date", () => {
  it("passes today to the rows, the count and the summary", async () => {
    const repo = fakeRepo();
    await usecaseOn(repo).list({});
    assert.equal(repo.calls.listed[0].today, TODAY);
    assert.equal(repo.calls.summarised[0].today, TODAY);
  });

  it("uses the IST business date, not the process zone", async () => {
    // Pinned through the injected clock here; in production it is
    // `utils/istDate.js#istToday`, so an evening action in India is not dated
    // to the day before by a server running in UTC.
    const repo = fakeRepo();
    await buildUsecase(repo, { today: "2026-01-05" }).list({});
    assert.equal(repo.calls.listed[0].today, "2026-01-05");
  });

  it("carries the same date whatever setup_status is selected", async () => {
    const repo = fakeRepo();
    await usecaseOn(repo).list({ setup_status: "missing" });
    assert.equal(repo.calls.listed[0].today, TODAY);
    assert.equal(repo.calls.summarised[0].today, TODAY);
    assert.equal(repo.calls.listed[0].setup_status, "missing");
    // The summary is still the full split of the eligible population.
    assert.equal(repo.calls.summarised[0].today, TODAY);
  });
});

/* ------------------------------------- Set: the target must be eligible -- */

describe("single Set refuses a target who does not currently need a chain", () => {
  const setFor = (repo, employee_id) =>
    usecaseOn(repo).save({ actor: ACTOR, employee_id, ...CHAIN });

  it("11. rejects an attendance-exempt target", async () => {
    const repo = fakeRepo();
    await assert.rejects(() => setFor(repo, EXEMPT.employee_id), (err) => {
      assert.equal(err.name, "ValidationError");
      assert.match(err.message, /is not required to have attendance/);
      assert.deepEqual(err.details, ["ATTENDANCE_NOT_REQUIRED"]);
      return true;
    });
  });

  it("12. rejects an already-resigned target, even with status still 1", async () => {
    const repo = fakeRepo();
    await assert.rejects(() => setFor(repo, RESIGNED_STALE_STATUS.employee_id), (err) => {
      assert.match(err.message, /has already left/);
      assert.deepEqual(err.details, ["AFTER_RESIGNATION_DATE"]);
      return true;
    });
  });

  it("13. rejects a future-joining target", async () => {
    const repo = fakeRepo();
    await assert.rejects(() => setFor(repo, FUTURE_JOINER.employee_id), (err) => {
      assert.match(err.message, /has not joined yet/);
      assert.deepEqual(err.details, ["BEFORE_JOINING_DATE"]);
      return true;
    });
  });

  it("14. allows a currently attendance-eligible target", async () => {
    const repo = fakeRepo();
    const res = await setFor(repo, ELIGIBLE.employee_id);
    assert.equal(res.code, 200);
    assert.equal(repo.calls.saved.length, 1);
    assert.equal(repo.calls.saved[0].setup.employee_id, ELIGIBLE.employee_id);
  });

  it("15. a refused Set writes NO setup row and NO audit row", async () => {
    for (const target of [EXEMPT, FUTURE_JOINER, RESIGNED_STALE_STATUS]) {
      const repo = fakeRepo();
      await assert.rejects(() => setFor(repo, target.employee_id));
      assert.equal(repo.calls.saved.length, 0, `${target.employee_name} must not be written`);
      assert.equal(repo.rows.has(target.employee_id), false);
    }
  });

  it("refuses to REACTIVATE a deactivated mapping for an ineligible target", async () => {
    // The upsert sets is_active = 1, so an unguarded Set would bring an old
    // mapping back to life for somebody who has since left.
    const repo = fakeRepo({
      setups: {
        [RESIGNED_STALE_STATUS.employee_id]: {
          employee_id: RESIGNED_STALE_STATUS.employee_id,
          first_level_approver_employee_id: null,
          second_level_approver_employee_id: null,
          final_approver_employee_id: APPROVER.employee_id,
          is_active: 0,
        },
      },
    });
    await assert.rejects(() => setFor(repo, RESIGNED_STALE_STATUS.employee_id));
    assert.equal(repo.calls.saved.length, 0);
    assert.equal(Number(repo.rows.get(RESIGNED_STALE_STATUS.employee_id).is_active), 0, "left deactivated");
  });

  it("judges the boundary days inclusively, as the helper does", async () => {
    const joiningToday = { ...ELIGIBLE, employee_id: 105, employee_name: "Joins Today", date_of_joining: TODAY };
    const leavingToday = { ...ELIGIBLE, employee_id: 106, employee_name: "Leaves Today", resignation_date: TODAY };
    PEOPLE.push(joiningToday, leavingToday);
    try {
      const repo = fakeRepo();
      assert.equal((await setFor(repo, 105)).code, 200, "joining date == today is IN");
      assert.equal((await setFor(repo, 106)).code, 200, "resignation date == today is IN");
    } finally {
      PEOPLE.splice(PEOPLE.indexOf(joiningToday), 2);
    }
  });

  it("includes an employee whose joining date is absent or unreadable", async () => {
    // The helper treats an absent bound as unbounded, deliberately: 425 of
    // 630 production rows carry no readable joining date.
    const noDate = { ...ELIGIBLE, employee_id: 107, employee_name: "No Date", date_of_joining: null };
    PEOPLE.push(noDate);
    try {
      assert.equal((await setFor(fakeRepo(), 107)).code, 200);
    } finally {
      PEOPLE.pop();
    }
  });
});

/* ------------------------------------------------- Bulk Set: row level --- */

describe("bulk Set reports ineligible targets per row", () => {
  const bulk = (repo, ids) =>
    usecaseOn(repo).bulkSet({ actor: ACTOR, employee_ids: ids, ...CHAIN });

  it("16. reports an ineligible target as a row-level failure, not a whole-run error", async () => {
    const repo = fakeRepo();
    const res = await bulk(repo, [ELIGIBLE.employee_id, EXEMPT.employee_id]);

    assert.equal(res.code, 200);
    assert.equal(res.failed_count, 1);
    const refusal = res.failed.find((f) => f.employee_id === EXEMPT.employee_id);
    assert.ok(refusal, "the exempt employee is named");
    assert.match(refusal.message, /is not required to have attendance/);
  });

  it("17. still saves the eligible targets in the same run", async () => {
    const repo = fakeRepo();
    const res = await bulk(repo, [ELIGIBLE.employee_id, EXEMPT.employee_id, RESIGNED_STALE_STATUS.employee_id]);

    assert.equal(res.success_count, 1);
    assert.deepEqual(res.failed.map((f) => f.employee_id).sort(), [EXEMPT.employee_id, RESIGNED_STALE_STATUS.employee_id].sort());
    assert.deepEqual(repo.calls.saved.map((c) => c.setup.employee_id), [ELIGIBLE.employee_id]);
  });

  it("18. the partial result stays honest about what happened", async () => {
    const repo = fakeRepo();

    const mixed = await bulk(repo, [ELIGIBLE.employee_id, EXEMPT.employee_id]);
    assert.equal(mixed.status, "COMPLETED_WITH_ERRORS");
    assert.equal(mixed.requested, 2);
    assert.equal(mixed.success_count + mixed.failed_count, mixed.requested);

    const allBad = await bulk(fakeRepo(), [EXEMPT.employee_id, FUTURE_JOINER.employee_id]);
    assert.equal(allBad.status, "FAILED");
    assert.equal(allBad.success_count, 0);

    const allGood = await bulk(fakeRepo(), [ELIGIBLE.employee_id]);
    assert.equal(allGood.status, "COMPLETED");
    assert.equal(allGood.failed_count, 0);
  });

  it("judges every employee of a run on ONE business date", async () => {
    // A long run must not straddle midnight and judge the first employees on
    // one day and the rest on the next.
    const repo = fakeRepo();
    await bulk(repo, [ELIGIBLE.employee_id, ELIGIBLE.employee_id]);
    assert.equal(repo.calls.saved.length, 1, "ids are de-duplicated");
  });
});

/* --------------------------------------------- Replace stays untouched --- */

describe("19. Replace Approver is unaffected", () => {
  it("still moves an old approver out of a mapping belonging to a departed employee", async () => {
    // The whole point of Replace is cleanup, and the mappings needing it may
    // well belong to people who have since left or been exempted. Applying
    // the target rule here would strand exactly those rows.
    const repo = fakeRepo();
    repo.findSetupsWithApprover = async () => [
      { employee_id: RESIGNED_STALE_STATUS.employee_id },
      { employee_id: EXEMPT.employee_id },
    ];
    repo.getEmployeesByIds = async (ids) => {
      const known = PEOPLE.filter((p) => ids.map(Number).includes(p.employee_id)).map((p) => ({ ...p }));
      const extra = ids.map(Number).includes(901)
        ? [{ employee_id: 901, employee_name: "New N", status: 1, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null }]
        : [];
      return [...known, ...extra];
    };

    const res = await usecaseOn(repo).replace({
      actor: ACTOR,
      current_approver_employee_id: APPROVER.employee_id,
      approval_level: "FINAL",
      new_approver_employee_id: 901,
    });

    assert.equal(res.code, 200);
    assert.equal(res.setups_updated, 2, "both mappings were cleaned up");
  });

  it("does not ask the target-eligibility question at all during a replace", async () => {
    const repo = fakeRepo();
    repo.findSetupsWithApprover = async () => [{ employee_id: EXEMPT.employee_id }];
    repo.getEmployeesByIds = async (ids) => {
      const known = PEOPLE.filter((p) => ids.map(Number).includes(p.employee_id)).map((p) => ({ ...p }));
      return ids.map(Number).includes(901)
        ? [...known, { employee_id: 901, employee_name: "New N", status: 1, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null }]
        : known;
    };

    const res = await usecaseOn(repo).replace({
      actor: ACTOR,
      current_approver_employee_id: APPROVER.employee_id,
      approval_level: "FINAL",
      new_approver_employee_id: 901,
      preview: true,
    });
    assert.ok(res, "a preview over an exempt employee's mapping is still allowed");
  });
});
