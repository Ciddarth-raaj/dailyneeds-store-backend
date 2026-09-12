/**
 * Void Punch - the usecase, over fakes with the exact shape the repositories
 * return.
 *
 *   node --test usecase/attendance_punch_void.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const build = require("./attendance_punch_void");
const { PENDING_REQUEST_MESSAGE, MIN_REASON_LENGTH } = require("./attendance_punch_void");

const ACTOR = { employee_id: 7, user_id: 70 };

/** A raw punch as `getRawPunchForVoid` returns it. */
const rawPunch = (overrides = {}) => ({
  biomax_punch_id: 1001,
  dev_id: "C26924B2E7351O35",
  user_id: "E0042",
  ingest_source: "LIVE",
  io_time: "2026-09-14 09:03:00",
  punch_date: "2026-09-14",
  employee_id: 42,
  ingest_attendance_date: "2026-09-14",
  employee_name: "Ravi",
  attendance_punch_void_id: null,
  void_reason: null,
  voided_by_employee_id: null,
  voided_at: null,
  ...overrides,
});

function fakeVoidRepo(punches = {}) {
  const store = { voids: [], rawReads: [] };
  let nextId = 500;
  return {
    store,
    getRawPunchForVoid: async (id) => {
      store.rawReads.push(id);
      return punches[id] || null;
    },
    insertVoid: async (row) => {
      if (store.voids.some((v) => v.biomax_punch_id === row.biomax_punch_id)) {
        return { attendance_punch_void_id: null, already_voided: true };
      }
      const id = nextId;
      nextId += 1;
      store.voids.push({ attendance_punch_void_id: id, voided_at: "2026-09-15 10:00:00", ...row });
      return { attendance_punch_void_id: id, already_voided: false };
    },
    getVoid: async (id) => {
      const v = store.voids.find((x) => x.attendance_punch_void_id === id);
      return v ? { ...v, voided_by_name: "HR Person" } : null;
    },
  };
}

function fakeCalculation(state = {}) {
  const calls = { dated: [], recalculated: [] };
  return {
    calls,
    attendanceDateForPunchTime: async (args) => {
      calls.dated.push(args);
      return state.attendanceDate === undefined ? "2026-09-14" : state.attendanceDate;
    },
    recalculateRange: async (args) => {
      calls.recalculated.push(args);
      if (state.recalcThrows) throw new Error(state.recalcThrows);
      return { ...args, written: 1, days: [{ attendance_date: args.from_date, punch_count: 2, status: "FINAL" }] };
    },
  };
}

function fakeRegularizationRepo(open = null) {
  const calls = [];
  return { calls, findOpenRequest: async (employeeId, date) => { calls.push([employeeId, date]); return open; } };
}

const wire = ({ punches, calc, open } = {}) => {
  const repo = fakeVoidRepo(punches || { 1001: rawPunch() });
  const calculation = fakeCalculation(calc || {});
  const regularization = fakeRegularizationRepo(open || null);
  return { repo, calculation, regularization, usecase: build(repo, calculation, regularization) };
};

describe("validation - decided from the punch the server reads, never the client", () => {
  it("25. the reason is required, and whitespace is not a reason", async () => {
    const { usecase } = wire();
    for (const reason of [undefined, null, "", "    ", "abc", "  ab  \n"]) {
      await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason, actor: ACTOR }), /reason of at least 5 characters/);
    }
    assert.equal(MIN_REASON_LENGTH, 5, "the same minimum the regularization reason uses");
  });

  it("26. a nonexistent punch is rejected as not found", async () => {
    const { usecase, repo } = wire();
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 9999, reason: "Duplicate device punch", actor: ACTOR }), (err) => {
      assert.equal(err.name, "NotFoundError");
      assert.match(err.message, /No raw punch exists for id 9999/);
      return true;
    });
    assert.equal(repo.store.voids.length, 0);
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: "abc", reason: "Duplicate device punch", actor: ACTOR }), /must be a raw punch id/);
  });

  it("24. a REGULARIZED punch cannot be voided: refused by source, and unnameable by id", async () => {
    const { usecase, repo } = wire();
    await assert.rejects(
      usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", source: "REGULARIZED", actor: ACTOR }),
      /REGULARIZED punch cannot be voided/
    );
    assert.equal(repo.store.rawReads.length, 0, "refused before anything is read");
    // and there is no way to reach attendance_regularized_punch: the
    // repository reads biomax_punch only.
    const src = fs.readFileSync(path.join(__dirname, "../repository/attendance_punch_void.js"), "utf8");
    assert.ok(!/attendance_regularized_punch/.test(src));
    assert.match(src, /FROM biomax_punch p/);
  });

  it("a claimed source that does not match the punch is refused", async () => {
    const { usecase } = wire();
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", source: "IMPORT", actor: ACTOR }), /is a BIOMAX punch, not IMPORT/);
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", source: "PAPER", actor: ACTOR }), /source must be BIOMAX or IMPORT/);
  });

  it("27. an already voided punch is rejected, naming the existing void", async () => {
    const { usecase, repo } = wire({
      punches: { 1001: rawPunch({ attendance_punch_void_id: 77, void_reason: "Earlier", voided_at: "2026-09-10 09:00:00" }) },
    });
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR }), /already voided \(void #77, 2026-09-10 09:00:00\)/);
    assert.equal(repo.store.voids.length, 0);
  });

  it("27b. a race on the unique key is reported as already voided, not as a 500", async () => {
    const { usecase, repo } = wire();
    repo.store.voids.push({ attendance_punch_void_id: 1, biomax_punch_id: 1001 });
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR }), /already voided/);
  });

  it("an unmatched punch (no employee) cannot be voided - it counts for nobody", async () => {
    const { usecase } = wire({ punches: { 1001: rawPunch({ employee_id: null, employee_name: null }) } });
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR }), /not matched to an employee/);
  });
});

describe("pending approval safety", () => {
  it("34. a PENDING REGULARIZATION on the punch's attendance date blocks the void with the approved message", async () => {
    const { usecase, repo } = wire({ open: { attendance_approval_request_id: 55, request_type: "REGULARIZATION", status: "PENDING" } });
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR }), (err) => {
      assert.equal(err.name, "ValidationError");
      assert.equal(err.message, PENDING_REQUEST_MESSAGE);
      assert.equal(err.message, "This attendance date has a pending Attendance/OT request. Decide or cancel it before voiding a raw punch.");
      assert.deepEqual(err.pending_request, { attendance_approval_request_id: 55, request_type: "REGULARIZATION", attendance_date: "2026-09-14" });
      return true;
    });
    assert.equal(repo.store.voids.length, 0, "nothing was written");
  });

  it("35. a PENDING OT request blocks it too", async () => {
    const { usecase, repo } = wire({ open: { attendance_approval_request_id: 56, request_type: "OT", status: "PENDING" } });
    await assert.rejects(usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR }), PENDING_REQUEST_MESSAGE.replace(/[.()]/g, "\\$&"));
    assert.equal(repo.store.voids.length, 0);
  });

  it("the pending check is made on the attendance date the ENGINE gives the punch, not the calendar date", async () => {
    const { usecase, regularization, calculation } = wire({
      punches: { 1001: rawPunch({ io_time: "2026-09-15 00:30:00", punch_date: "2026-09-15", ingest_attendance_date: "2026-09-15" }) },
      calc: { attendanceDate: "2026-09-14" },
    });
    const result = await usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR });
    assert.deepEqual(regularization.calls, [[42, "2026-09-14"]]);
    assert.deepEqual(calculation.calls.dated, [{ employee_id: 42, punch_time: "2026-09-15 00:30:00", near_date: "2026-09-15" }]);
    assert.equal(result.attendance_date, "2026-09-14");
    assert.deepEqual(calculation.calls.recalculated, [{ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-14" }]);
  });

  it("36. an APPROVED or REJECTED historical request is not a block and is never rewritten", async () => {
    // findOpenRequest only returns PENDING rows (its SQL says so); a decided
    // request is invisible to the void, and the void writes nothing to the
    // approval tables.
    const { usecase, repo } = wire({ open: null });
    const result = await usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR });
    assert.equal(result.code, 200);
    assert.equal(repo.store.voids.length, 1);
    const repoSrc = fs.readFileSync(path.join(__dirname, "../repository/attendance_punch_void.js"), "utf8");
    assert.ok(!/attendance_approval_request|attendance_approval_step/.test(repoSrc));
    const regSrc = fs.readFileSync(path.join(__dirname, "../repository/attendance_regularization.js"), "utf8");
    assert.match(regSrc, /FIND-OPEN-REQUEST[\s\S]*?status = 'PENDING'/, "findOpenRequest sees PENDING rows only");
  });
});

describe("a successful void", () => {
  it("22. a BIOMAX punch can be voided; 28. the record stores the actor, the timestamp and the punch snapshot", async () => {
    const { usecase, repo } = wire();
    const result = await usecase.voidPunch({ biomax_punch_id: 1001, reason: "  Duplicate device punch  ", actor: ACTOR });
    assert.equal(result.code, 200);
    assert.equal(repo.store.voids.length, 1);
    const v = repo.store.voids[0];
    assert.equal(v.biomax_punch_id, 1001);
    assert.equal(v.punch_source, "BIOMAX");
    assert.equal(v.employee_id, 42, "from the punch, not the client");
    assert.equal(v.punch_io_time, "2026-09-14 09:03:00", "the original time, snapshotted");
    assert.equal(v.attendance_date, "2026-09-14");
    assert.equal(v.reason, "Duplicate device punch", "trimmed");
    assert.equal(v.voided_by_employee_id, 7);
    assert.equal(v.voided_by_user_id, 70);
    assert.ok(v.voided_at);
    assert.equal(result.voided_by_name, "HR Person");
    assert.equal(result.punch_source, "BIOMAX");
    assert.equal(result.employee_name, "Ravi");
  });

  it("23. an IMPORT punch (DIGISME_IMPORT) can be voided and is recorded as IMPORT", async () => {
    const { usecase, repo } = wire({ punches: { 2002: rawPunch({ biomax_punch_id: 2002, dev_id: null, ingest_source: "DIGISME_IMPORT" }) } });
    const result = await usecase.voidPunch({ biomax_punch_id: 2002, reason: "Invalid imported punch", source: "IMPORT", actor: ACTOR });
    assert.equal(result.punch_source, "IMPORT");
    assert.equal(repo.store.voids[0].punch_source, "IMPORT");
  });

  it("29. the raw punch row is never written: the repository issues no INSERT/UPDATE/DELETE against biomax_punch", () => {
    const src = fs
      .readFileSync(path.join(__dirname, "../repository/attendance_punch_void.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const writes = [...src.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+`?(\w+)`?/g)].map((m) => m[2]);
    assert.deepEqual([...new Set(writes)], ["attendance_punch_void"]);
    assert.ok(!/DELETE/.test(src));
  });

  it("33. the void triggers the EXISTING single employee/date recalculation, and the answer says it succeeded", async () => {
    const { usecase, calculation } = wire();
    const result = await usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR });
    assert.deepEqual(calculation.calls.recalculated, [{ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-14" }]);
    assert.equal(result.recalculated, true);
    assert.equal(result.recalculation_error, null);
    assert.equal(result.day.attendance_date, "2026-09-14");
    assert.match(result.msg, /voided and 2026-09-14 recalculated/);
  });

  it("if the recalculation fails AFTER the void is stored, the answer does not lie: void saved, recalculated false, the error named", async () => {
    const { usecase, repo } = wire({ calc: { recalcThrows: "connection lost" } });
    const result = await usecase.voidPunch({ biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR });
    assert.equal(result.code, 200);
    assert.equal(repo.store.voids.length, 1, "the void survived");
    assert.equal(result.recalculated, false);
    assert.equal(result.recalculation_error, "connection lost");
    assert.match(result.msg, /could NOT be recalculated: connection lost\. Run Recalculate Attendance/);
  });

  it("the client cannot supply the employee, the actor or the original time: the usecase reads them from the punch and the session", async () => {
    const { usecase, repo } = wire();
    await usecase.voidPunch({
      biomax_punch_id: 1001, reason: "Duplicate device punch", actor: ACTOR,
      employee_id: 1, voided_by: 2, io_time: "2020-01-01 00:00:00", punch_io_time: "2020-01-01 00:00:00",
    });
    const v = repo.store.voids[0];
    assert.equal(v.employee_id, 42);
    assert.equal(v.voided_by_employee_id, 7);
    assert.equal(v.punch_io_time, "2026-09-14 09:03:00");
  });
});

describe("41. the Biomax receiver is untouched", () => {
  it("nothing under biomax/ knows about voids or the ten-minute rule", () => {
    const dir = path.join(__dirname, "../biomax");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!/attendance_effective_punches|attendance_punch_void|DUPLICATE_WINDOW/.test(src), `${f} is untouched`);
    }
  });
});
