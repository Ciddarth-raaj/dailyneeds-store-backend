/**
 * THE TELEGRAM ATTENDANCE MINI APP - the read and the write.
 *
 *   node --test usecase/telegram_attendance_miniapp.test.js
 *
 * THE MISSING-DATE TESTS RUN THE REAL `usecase/attendance_missing.js` over a
 * faked repository and a faked dashboard, rather than stubbing the population
 * out. That is deliberate: the approved requirement is that the Mini App's
 * list comes from the SHARED Missing Attendance rule, and a stub would let
 * that stop being true without a single test going red. 1 / 3 / 5 / 7 punches
 * are odd here because `utils/attendance_missing.js` says so, not because
 * anything in the Mini App counts.
 *
 * The regularisation tests use a recording double for
 * `attendanceRegularizationUsecase` - not to replace its rules, but to assert
 * that the Mini App reaches the REAL `raiseRequest` with the actor and the
 * requested-for employee both set to the authenticated employee, and adds
 * nothing of its own.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildMissingUsecase = require("../usecase/attendance_missing");
const buildMiniApp = require("../usecase/telegram_attendance_miniapp");

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

const employee = (employee_id) => ({
  employee_id,
  employee_name: `Employee ${employee_id}`,
  attendance_required: 1,
  date_of_joining: "2024-01-01",
  resignation_date: null,
  store_id: 3,
  department_id: 2,
});

/**
 * The dashboard, faked at the two methods the population calls. `days` is a
 * map of `employee_id:date -> punch_count` (or a whole day object).
 */
const fakeDashboard = (days) => ({
  loadBatch: async () => ({}),
  computeDaysForEmployee: ({ employee: emp, dates }) =>
    dates.map((date) => {
      const found = days[`${emp.employee_id}:${date}`];
      const day = typeof found === "object" && found !== null ? found : { punch_count: found };
      return {
        attendance_date: date,
        work_shift_id: 4,
        shift_name: "General",
        shift_code: "GEN",
        status: "FINAL",
        effective_punches: [],
        punch_count: 0,
        ...day,
      };
    }),
});

const fakeMissingRepo = (employees) => ({
  listCandidateEmployees: async ({ employee_id }) =>
    employees.filter((e) => (employee_id ? Number(e.employee_id) === Number(employee_id) : true)),
});

/** A regularization usecase that records its one call and invents no rule. */
const recordingRegularization = (result = {}, requests = []) => {
  const calls = [];
  const listCalls = [];
  return {
    calls,
    listCalls,
    MAX_BACKDATE_DAYS: 45,
    listForEmployee: async (filters) => {
      listCalls.push(filters);
      return requests.filter((r) => Number(filters.employee_id) === 77 || false);
    },
    raiseRequest: async (args) => {
      calls.push(args);
      return {
        attendance_approval_request_id: 900,
        status: "PENDING",
        attendance_date: args.attendance_date,
        chain: [{ stage_no: 1, approver_role: "STORE_MANAGER" }],
        ...result,
      };
    },
  };
};

const request = (attendance_date, status, id = 500) => ({
  attendance_approval_request_id: id,
  request_type: "REGULARIZATION",
  attendance_date,
  status,
});

const build = ({ employees = [employee(77)], days = {}, regularization, calculation } = {}) => {
  const attendanceMissingUsecase = buildMissingUsecase(fakeMissingRepo(employees), fakeDashboard(days));
  const attendanceRegularizationUsecase = regularization || recordingRegularization();
  const attendanceCalculationUsecase = calculation || {
    readRange: async ({ employee_id, from_date }) => [
      {
        attendance_date: from_date,
        employee_id,
        status: "REVIEW_REQUIRED",
        shift_name: "General",
        shift_snapshot: { work_shift_id: 4, shift_code: "GEN", in_time: "10:00:00", out_time: "22:00:00", attendance_day_cutoff: "04:00:00" },
        effective_punches: [{ punch_id: 11, io_time: `${from_date} 10:02:00`, source: "BIOMAX" }],
        punch_count: 1,
      },
    ],
  };
  return {
    miniApp: buildMiniApp({
      attendanceMissingUsecase,
      attendanceCalculationUsecase,
      attendanceRegularizationUsecase,
    }),
    attendanceRegularizationUsecase,
  };
};

const datesOf = (list) => list.dates.map((d) => d.attendance_date);

describe("the missing-date list comes from the shared rule", () => {
  it("includes odd punch counts - 1, 3, 5 and 7 alike, with nothing listing them", async () => {
    const { miniApp } = build({
      days: {
        "77:2026-09-14": 1,
        "77:2026-09-15": 3,
        "77:2026-09-16": 5,
        "77:2026-09-17": 7,
      },
    });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.deepEqual(datesOf(list), ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
  });

  it("excludes ZERO punches - an absence is not this workflow", async () => {
    const { miniApp } = build({ days: { "77:2026-09-15": 0, "77:2026-09-16": 3 } });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.deepEqual(datesOf(list), ["2026-09-16"]);
  });

  it("excludes EVEN punch counts", async () => {
    const { miniApp } = build({ days: { "77:2026-09-15": 2, "77:2026-09-16": 4, "77:2026-09-17": 3 } });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.deepEqual(datesOf(list), ["2026-09-17"]);
  });

  /**
   * TODAY IS NEVER MISSING ATTENDANCE. Somebody who has clocked in and not
   * out has one punch; telling them their day is broken while they are still
   * working is the failure the shared rule exists to prevent.
   */
  it("excludes TODAY even though today's count is odd", async () => {
    const { miniApp } = build({ days: { [`77:${TODAY}`]: 1, [`77:${YESTERDAY}`]: 1 } });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.deepEqual(datesOf(list), [YESTERDAY]);
  });

  it("stops at the regularisation backdate window owned by the regularization usecase", async () => {
    const reg = recordingRegularization();
    reg.MAX_BACKDATE_DAYS = 3;
    const { miniApp } = build({
      regularization: reg,
      days: { "77:2026-09-10": 1, "77:2026-09-17": 1 },
    });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.equal(miniApp.backdateDays(), 3);
    assert.deepEqual(datesOf(list), ["2026-09-17"]);
  });

  it("carries NO punch count to the employee", async () => {
    const { miniApp } = build({ days: { "77:2026-09-17": 5 } });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    const text = JSON.stringify(list);
    assert.ok(!/punch_count/.test(text), text);
    assert.ok(!/punch_times/.test(text), text);
  });

  it("shows an already-raised request as Regularisation Pending, not submittable", async () => {
    const { miniApp } = build({
      days: {
        "77:2026-09-15": { punch_count: 3, regularization_request_id: 41, regularization_request_pending: true },
        "77:2026-09-17": 3,
      },
    });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    const pending = list.dates.find((d) => d.attendance_date === "2026-09-15");
    assert.equal(pending.state, "PENDING");
    assert.equal(pending.state_label, "Regularisation Pending");
    assert.equal(pending.can_submit, false);
    assert.equal(list.dates.find((d) => d.attendance_date === "2026-09-17").can_submit, true);
  });
});

describe("an employee sees only their own dates", () => {
  it("another employee's missing date is never in the list", async () => {
    const { miniApp } = build({
      employees: [employee(77), employee(78)],
      days: { "77:2026-09-17": 3, "78:2026-09-16": 3 },
    });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.deepEqual(datesOf(list), ["2026-09-17"]);
  });

  /**
   * The guarantee is that the BROWSER NEVER CHOOSES, SUPPLIES OR CONTROLS
   * the employee id - not that the id is a secret. It is in the scoped
   * token's signed claim and in the audit log, both of which the client
   * cannot touch. It is kept out of the response bodies because the screen
   * has no use for it, and a field a client is handed is a field a client
   * starts sending back.
   */
  it("no response body carries an employee id", async () => {
    const { miniApp } = build({ days: { "77:2026-09-17": 1 } });

    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.ok(!/employee/i.test(JSON.stringify(list)), JSON.stringify(list));

    const detail = await miniApp.getDateDetail(77, "2026-09-17", { today: TODAY });
    assert.ok(!/employee/i.test(JSON.stringify(detail)), JSON.stringify(detail));

    const out = await miniApp.submitRegularization(77, {
      attendance_date: "2026-09-17",
      punch_time: "2026-09-17 19:30:00",
      reason: "Forgot to punch out",
    });
    assert.ok(!/employee/i.test(JSON.stringify(out)), JSON.stringify(out));
  });

  /**
   * `raiseRequest` returns the whole created request - chain, proposed day,
   * requester class, both employee ids. The Mini App returns a narrowed
   * confirmation instead of spreading it, so an HR-shaped payload cannot
   * reach a WebView because somebody added a field upstream.
   */
  it("the submit confirmation is narrowed, not spread", async () => {
    const wide = recordingRegularization({
      requested_for_employee_id: 77,
      requested_by_employee_id: 77,
      proposed_day: { punch_count: 4, employee_id: 77 },
      requester_class: "STORE_EMPLOYEE",
    });
    const { miniApp } = build({ regularization: wide });
    const out = await miniApp.submitRegularization(77, {
      attendance_date: "2026-09-17",
      punch_time: "2026-09-17 19:30:00",
      reason: "Forgot to punch out",
    });
    assert.deepEqual(Object.keys(out).sort(), [
      "attendance_date",
      "auto_approved",
      "code",
      "request_id",
      "status",
    ]);
    assert.equal(out.request_id, 900);
  });

  it("the list takes an employee id as an ARGUMENT - there is no request to read one from", () => {
    const { miniApp } = build();
    assert.ok(miniApp.listMissingDates.length >= 1);
    assert.ok(miniApp.getDateDetail.length >= 2);
    assert.ok(miniApp.submitRegularization.length >= 2);
  });

  it("refuses without an employee identity rather than listing everybody", async () => {
    const { miniApp } = build();
    await assert.rejects(() => miniApp.listMissingDates(null), (e) => e.name === "ValidationError");
    await assert.rejects(() => miniApp.listMissingDates(0), (e) => e.name === "ValidationError");
  });
});

describe("the date detail", () => {
  it("returns the shift and the existing punches from the ordinary attendance read", async () => {
    const { miniApp } = build({ days: { "77:2026-09-17": 1 } });
    const detail = await miniApp.getDateDetail(77, "2026-09-17", { today: TODAY });
    assert.equal(detail.attendance_date, "2026-09-17");
    assert.equal(detail.day.shift_snapshot.shift_code, "GEN");
    assert.equal(detail.employee_id, undefined);
    assert.equal(detail.day.effective_punches.length, 1);
    assert.equal(detail.can_submit, true);
  });

  it("a date that is NOT missing attendance comes back with its state, not a usable form", async () => {
    const { miniApp } = build({ days: { "77:2026-09-17": 2 } });
    const detail = await miniApp.getDateDetail(77, "2026-09-17", { today: TODAY });
    assert.equal(detail.can_submit, false);
    assert.equal(detail.state, "NOT_ACTIONABLE");
  });

  it("today and the future are refused - they are not completed attendance dates", async () => {
    const { miniApp } = build();
    await assert.rejects(
      () => miniApp.getDateDetail(77, TODAY, { today: TODAY }),
      (e) => e.name === "ValidationError"
    );
    await assert.rejects(
      () => miniApp.getDateDetail(77, "2026-10-01", { today: TODAY }),
      (e) => e.name === "ValidationError"
    );
  });

  it("the calculated read is asked for the authenticated employee only", async () => {
    const asked = [];
    const { miniApp } = build({
      days: { "77:2026-09-17": 1 },
      calculation: {
        readRange: async (args) => {
          asked.push(args);
          return [];
        },
      },
    });
    await miniApp.getDateDetail(77, "2026-09-17", { today: TODAY });
    assert.deepEqual(asked, [{ employee_id: 77, from_date: "2026-09-17", to_date: "2026-09-17" }]);
  });
});

describe("submission reuses the existing regularisation engine", () => {
  it("calls raiseRequest with actor and requested-for both the authenticated employee", async () => {
    const { miniApp, attendanceRegularizationUsecase } = build();
    const out = await miniApp.submitRegularization(77, {
      attendance_date: "2026-09-17",
      punch_time: "2026-09-17 19:30:00",
      reason: "Forgot to punch out",
    });
    assert.equal(out.code, 200);
    assert.equal(attendanceRegularizationUsecase.calls.length, 1);
    const call = attendanceRegularizationUsecase.calls[0];
    assert.equal(call.actor.employee_id, 77);
    assert.equal(call.requested_for_employee_id, 77);
    assert.equal(call.attendance_date, "2026-09-17");
    assert.equal(call.punch_time, "2026-09-17 19:30:00");
    assert.equal(call.reason, "Forgot to punch out");
  });

  /**
   * THE WHOLE POINT. Whatever a caller puts in the payload object, the two
   * employee ids handed to the engine are the authenticated one - there is
   * no parameter that carries another.
   */
  it("a requested_for_employee_id smuggled into the payload reaches nothing", async () => {
    const { miniApp, attendanceRegularizationUsecase } = build();
    await miniApp.submitRegularization(77, {
      attendance_date: "2026-09-17",
      punch_time: "2026-09-17 19:30:00",
      reason: "Forgot to punch out",
      requested_for_employee_id: 78,
      employee_id: 78,
      actor: { employee_id: 78 },
    });
    const call = attendanceRegularizationUsecase.calls[0];
    assert.equal(call.actor.employee_id, 77);
    assert.equal(call.requested_for_employee_id, 77);
    assert.equal(call.employee_id, undefined);
  });

  it("passes NO punch id, so an existing punch cannot be edited or deleted", async () => {
    const { miniApp, attendanceRegularizationUsecase } = build();
    await miniApp.submitRegularization(77, {
      attendance_date: "2026-09-17",
      punch_time: "2026-09-17 19:30:00",
      reason: "Forgot to punch out",
      punch_id: 11,
    });
    const text = JSON.stringify(attendanceRegularizationUsecase.calls[0]);
    assert.ok(!/punch_id/.test(text), text);
  });

  /**
   * Every refusal the engine owns - a duplicate open request, a complete
   * day, a closed period, a shift that forbids regularisation - travels
   * straight back out. The Mini App neither catches nor softens one.
   */
  it("a refusal from the engine is not swallowed", async () => {
    const refusing = {
      MAX_BACKDATE_DAYS: 45,
      raiseRequest: async () => {
        const err = new Error("There is already an open request for 2026-09-17 (#41)");
        err.name = "ValidationError";
        throw err;
      },
    };
    const { miniApp } = build({ regularization: refusing });
    await assert.rejects(
      () =>
        miniApp.submitRegularization(77, {
          attendance_date: "2026-09-17",
          punch_time: "2026-09-17 19:30:00",
          reason: "Forgot to punch out",
        }),
      (e) => e.name === "ValidationError" && /already an open request/.test(e.message)
    );
  });

  /**
   * The chain is the ENGINE's and is created by it; the Mini App does not
   * echo it back to the WebView, which has no approval screen to show it on.
   * What the employee gets is the state of their own request.
   */
  it("the ordinary approval chain is created, and the confirmation states the request", async () => {
    const { miniApp, attendanceRegularizationUsecase } = build();
    const out = await miniApp.submitRegularization(77, {
      attendance_date: "2026-09-17",
      punch_time: "2026-09-17 19:30:00",
      reason: "Forgot to punch out",
    });
    assert.equal(out.status, "PENDING");
    assert.equal(out.request_id, 900);
    assert.equal(out.auto_approved, false);
    // The chain really was created by the engine, on the ordinary path.
    assert.equal(attendanceRegularizationUsecase.calls.length, 1);
  });

  it("audits the submission with the employee, the date and the session", async () => {
    const lines = [];
    const attendanceMissingUsecase = buildMissingUsecase(fakeMissingRepo([employee(77)]), fakeDashboard({}));
    const miniApp = buildMiniApp({
      attendanceMissingUsecase,
      attendanceCalculationUsecase: { readRange: async () => [] },
      attendanceRegularizationUsecase: recordingRegularization(),
      log: { LEVEL: { INFO: "info" }, Log: (l) => lines.push(l) },
    });
    await miniApp.submitRegularization(
      77,
      { attendance_date: "2026-09-17", punch_time: "2026-09-17 19:30:00", reason: "Forgot" },
      { session_id: "abc123", telegram_user_id: 501 }
    );
    const line = lines.find((l) => /REGULARIZATION-SUBMITTED/.test(l.code));
    assert.ok(line);
    assert.equal(line.ref.employee_id, 77);
    assert.equal(line.ref.attendance_date, "2026-09-17");
    assert.equal(line.ref.session_id, "abc123");
    assert.equal(line.ref.telegram_user_id, 501);
  });
});

/* ===================================================================
 * MY ATTENDANCE
 * =================================================================== */
describe("My Attendance is the existing calculated read, one month of it", () => {
  const monthApp = (readRange) =>
    buildMiniApp({
      attendanceMissingUsecase: buildMissingUsecase(fakeMissingRepo([employee(77)]), fakeDashboard({})),
      attendanceCalculationUsecase: { readRange },
      attendanceRegularizationUsecase: recordingRegularization(),
    });

  it("asks readRange for the authenticated employee and the whole month", async () => {
    const asked = [];
    const miniApp = monthApp(async (a) => {
      asked.push(a);
      return [{ attendance_date: "2026-08-01", status: "FINAL" }];
    });
    const out = await miniApp.getMonth(77, "2026-08", { today: TODAY });
    assert.deepEqual(asked, [{ employee_id: 77, from_date: "2026-08-01", to_date: "2026-08-31" }]);
    assert.equal(out.month, "2026-08");
    assert.equal(out.days.length, 1);
  });

  /**
   * The current month stops at today. A tail of empty future days would read
   * as "you were absent for the rest of September".
   */
  it("clamps the CURRENT month to today rather than reading the future", async () => {
    const asked = [];
    const miniApp = monthApp(async (a) => {
      asked.push(a);
      return [];
    });
    const out = await miniApp.getMonth(77, "2026-09", { today: TODAY });
    assert.deepEqual(asked, [{ employee_id: 77, from_date: "2026-09-01", to_date: TODAY }]);
    assert.equal(out.to_date, TODAY);
  });

  it("a month wholly in the future reads nothing at all", async () => {
    let called = false;
    const miniApp = monthApp(async () => {
      called = true;
      return [];
    });
    const out = await miniApp.getMonth(77, "2026-12", { today: TODAY });
    assert.deepEqual(out.days, []);
    assert.equal(called, false, "the engine is not asked about a month that has not started");
  });

  it("validates the month and refuses anything else", async () => {
    const miniApp = monthApp(async () => []);
    for (const bad of ["2026-13", "2026-00", "2026-9", "26-09", "2026-09-01", "", null, 202609]) {
      await assert.rejects(
        () => miniApp.getMonth(77, bad, { today: TODAY }),
        (e) => e.name === "ValidationError",
        `month ${JSON.stringify(bad)} must be refused`
      );
    }
  });

  it("refuses without an employee identity", async () => {
    const miniApp = monthApp(async () => []);
    await assert.rejects(() => miniApp.getMonth(null, "2026-08"), (e) => e.name === "ValidationError");
  });

  /**
   * THE DAYS ARE THE ENGINE'S, UNTOUCHED. Every attendance state the screen
   * shows is one `readRange` already produced; the Mini App re-labels
   * nothing and adds no field of its own.
   */
  it("passes the engine's days through without adding or re-labelling anything", async () => {
    const engineDay = {
      attendance_date: "2026-08-03",
      status: "REVIEW_REQUIRED",
      review_reasons: ["MISSING_PUNCH"],
      punch_count: 1,
      worked_minutes: 0,
      nrm_minutes: 540,
      short_minutes: 540,
      shift_snapshot: { shift_code: "GEN", in_time: "10:00:00", out_time: "22:00:00" },
      effective_punches: [{ punch_id: 3, io_time: "2026-08-03 10:02:00", source: "BIOMAX" }],
      ot_claim_state: "AVAILABLE",
      calculation_source: "STORED",
    };
    const miniApp = monthApp(async () => [engineDay]);
    const out = await miniApp.getMonth(77, "2026-08", { today: TODAY });
    assert.deepEqual(out.days[0], engineDay);
  });

  it("no response body carries an employee id", async () => {
    const miniApp = monthApp(async () => [{ attendance_date: "2026-08-01", status: "FINAL" }]);
    const out = await miniApp.getMonth(77, "2026-08", { today: TODAY });
    const { days, ...envelope } = out;
    assert.ok(!/employee/i.test(JSON.stringify(envelope)), JSON.stringify(envelope));
  });
});

/* ===================================================================
 * CORRECTIONS: the decided requests, from the engine that owns them
 * =================================================================== */
describe("the Corrections list shows what came of what was filed", () => {
  it("an APPROVED date stays on the list even though it is no longer 'missing'", async () => {
    // 4 punches: the shared Missing Attendance rule excludes it entirely.
    const reg = recordingRegularization({}, [request("2026-09-12", "APPROVED", 41)]);
    const { miniApp } = build({ regularization: reg, days: { "77:2026-09-12": 4 } });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    const card = list.dates.find((d) => d.attendance_date === "2026-09-12");
    assert.ok(card, "the approved correction is still visible");
    assert.equal(card.state, "APPROVED");
    assert.equal(card.state_label, "Regularised");
    assert.equal(card.can_submit, false);
    assert.equal(card.correction_request_id, 41);
  });

  /**
   * A rejection does not close the date. `findOpenRequest` in the existing
   * engine blocks only an OPEN request, so the screen must not offer less
   * than the backend allows.
   */
  it("a REJECTED request on a still-missing date is actionable again", async () => {
    const reg = recordingRegularization({}, [request("2026-09-12", "REJECTED", 42)]);
    const { miniApp } = build({ regularization: reg, days: { "77:2026-09-12": 3 } });
    const card = (await miniApp.listMissingDates(77, { today: TODAY })).dates[0];
    assert.equal(card.state, "REJECTED");
    assert.equal(card.state_label, "Regularisation Rejected");
    assert.equal(card.can_submit, true);
  });

  it("a PENDING request is pending and is not submittable", async () => {
    const reg = recordingRegularization({}, [request("2026-09-12", "PENDING", 43)]);
    const { miniApp } = build({ regularization: reg, days: { "77:2026-09-12": 3 } });
    const card = (await miniApp.listMissingDates(77, { today: TODAY })).dates[0];
    assert.equal(card.state, "PENDING");
    assert.equal(card.can_submit, false);
  });

  it("an OT request is not a correction and never appears here", async () => {
    const reg = recordingRegularization({}, [
      { attendance_approval_request_id: 44, request_type: "OT", attendance_date: "2026-09-12", status: "PENDING" },
    ]);
    const { miniApp } = build({ regularization: reg, days: {} });
    assert.deepEqual((await miniApp.listMissingDates(77, { today: TODAY })).dates, []);
  });

  it("the request read is pinned to the authenticated employee and the window", async () => {
    const reg = recordingRegularization({}, []);
    reg.MAX_BACKDATE_DAYS = 10;
    const { miniApp } = build({ regularization: reg, days: {} });
    await miniApp.listMissingDates(77, { today: TODAY });
    assert.equal(reg.listCalls.length, 1);
    assert.equal(reg.listCalls[0].employee_id, 77);
    assert.equal(reg.listCalls[0].from_date, "2026-09-09");
    assert.equal(reg.listCalls[0].to_date, "2026-09-18");
  });

  it("dates stay in ascending order once the two sources are merged", async () => {
    const reg = recordingRegularization({}, [request("2026-09-10", "APPROVED", 45)]);
    const { miniApp } = build({
      regularization: reg,
      days: { "77:2026-09-17": 3, "77:2026-09-14": 1 },
    });
    const list = await miniApp.listMissingDates(77, { today: TODAY });
    assert.deepEqual(datesOf(list), ["2026-09-10", "2026-09-14", "2026-09-17"]);
  });

  it("works against a regularization usecase with no listForEmployee at all", async () => {
    const reg = recordingRegularization();
    delete reg.listForEmployee;
    const { miniApp } = build({ regularization: reg, days: { "77:2026-09-17": 3 } });
    assert.deepEqual(datesOf(await miniApp.listMissingDates(77, { today: TODAY })), ["2026-09-17"]);
  });
});
