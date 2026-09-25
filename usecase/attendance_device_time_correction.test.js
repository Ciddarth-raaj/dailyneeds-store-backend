/**
 * DEVICE TIME CORRECTION - the usecase and the route, without a database.
 *
 *   node --test usecase/attendance_device_time_correction.test.js
 *
 * The transactional behaviour (the payroll lock under `FOR UPDATE`, the
 * UNIQUE active-punch key, rollback, the effective-time reads and the real
 * engine recalculating from them) is proven against real SQL in
 * `repository/attendance_device_time_correction.mysql.test.js`. This file
 * covers what needs no database: the arithmetic, the validation, the
 * administrator-only rule, that Preview calls no writer, and the route.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const buildUsecase = require("./attendance_device_time_correction");
const { addMinutesToIoTime, parseClock, fingerprintOf } = require("./attendance_device_time_correction");
const buildRoutes = require("../routes/attendance_device_time_correction");

const ADMIN = { employee_id: 900, user_id: 7, user_type: 2 };
const DATE = "2026-09-25";

const INPUT = {
  date: DATE,
  biomax_device_id: 1,
  from_time: "06:30",
  to_time: "08:30",
  offset_minutes: 150,
  reason_code: "BIOMAX_DEVICE_TIME_ERROR",
  remarks: "WH showed 06:30 when the real time was 09:00",
};

const punch = (id, employeeId, ioTime, extra = {}) => ({
  biomax_punch_id: id,
  dev_id: "C2695C56D30E1430",
  user_id: String(employeeId),
  ingest_source: "LIVE",
  io_time: ioTime,
  received_at: ioTime,
  employee_id: employeeId,
  employee_name: `E${employeeId}`,
  biomax_device_id: 1,
  device_label: "WH",
  punch_outlet_id: 2,
  punch_outlet_name: "Warehouse",
  active_correction_id: null,
  attendance_punch_void_id: null,
  ...extra,
});

/** A repository that records every call; the write methods are listed. */
function fakeRepo({ punches = [], batch = null } = {}) {
  const calls = [];
  const WRITES = ["applyCorrection", "revertCorrection"];
  const repo = {
    calls,
    writes: () => calls.filter((c) => WRITES.includes(c.name)),
    getDevice: async (id) => {
      calls.push({ name: "getDevice" });
      return id === 1
        ? { biomax_device_id: 1, dev_id: "C2695C56D30E1430", label: "WH",
            assignments: [{ outlet_id: 2, outlet_name: "Warehouse", effective_from: "2026-09-01 00:00:00", effective_to: null }] }
        : null;
    },
    selectCandidatePunches: async () => {
      calls.push({ name: "selectCandidatePunches" });
      return punches;
    },
    findPendingRequests: async () => {
      calls.push({ name: "findPendingRequests" });
      return [];
    },
    findByBatchRef: async () => null,
    getCorrection: async () => batch,
    applyCorrection: async (args) => {
      calls.push({ name: "applyCorrection", args });
      return { attendance_device_time_correction_id: 1, written: args.calculation_rows.length };
    },
    revertCorrection: async (args) => {
      calls.push({ name: "revertCorrection", args });
      return { attendance_device_time_correction_id: args.correction_id };
    },
  };
  return repo;
}

function fakeCalc({ locked = [] } = {}) {
  const calls = [];
  return {
    calls,
    attendanceDatesForPunchTimes: async ({ punch_times }) => punch_times.map((t) => t.slice(0, 10)),
    findPayrollLockedPeriods: async () => locked,
    calculateForTimeCorrection: async (args) => {
      calls.push(args);
      return {
        rows: args.attendance_dates.map((d) => ({ employee_id: args.employee_id, attendance_date: d })),
        days: args.attendance_dates.map((d) => ({ attendance_date: d, status: "FINAL" })),
        skipped_open_dates: [],
        ineligible_dates: [],
      };
    },
  };
}

const build = (repo, calc = fakeCalc()) => buildUsecase(repo, calc, { today: "2026-09-27" });

describe("the arithmetic", () => {
  it("5. +150 minutes: 06:42:15 -> 09:12:15", () => {
    assert.equal(addMinutesToIoTime("2026-09-25 06:42:15", 150), "2026-09-25 09:12:15");
    assert.equal(addMinutesToIoTime("2026-09-25 06:30:00", 137), "2026-09-25 08:47:00");
  });

  it("6. negative offsets work and keep the seconds", () => {
    assert.equal(addMinutesToIoTime("2026-09-25 09:12:15", -150), "2026-09-25 06:42:15");
    assert.equal(addMinutesToIoTime("2026-09-25 06:45:00", -30), "2026-09-25 06:15:00");
  });

  it("crosses midnight arithmetically (the usecase then refuses it)", () => {
    assert.equal(addMinutesToIoTime("2026-09-25 23:00:00", 90), "2026-09-26 00:30:00");
    assert.equal(addMinutesToIoTime("2026-09-25 00:10:00", -20), "2026-09-24 23:50:00");
  });

  it("parses HH:MM and HH:MM:SS, and nothing else", () => {
    assert.equal(parseClock("6:30"), "06:30:00");
    assert.equal(parseClock("08:30:59"), "08:30:59");
    assert.equal(parseClock("24:00"), null);
    assert.equal(parseClock("08:60"), null);
    assert.equal(parseClock("0830"), null);
  });

  it("the fingerprint changes with the punch set AND with the offset", () => {
    const c = { date: DATE, biomax_device_id: 1, outlet_id: null, window_from: `${DATE} 06:30:00`, window_to: `${DATE} 08:30:00`, offset_minutes: 150 };
    const p = [punch(1, 501, `${DATE} 06:42:15`)];
    const base = fingerprintOf(c, p);
    assert.equal(fingerprintOf(c, [...p]), base);
    assert.notEqual(fingerprintOf({ ...c, offset_minutes: 140 }, p), base);
    assert.notEqual(fingerprintOf(c, [...p, punch(2, 502, `${DATE} 07:00:00`)]), base);
    assert.notEqual(fingerprintOf(c, [{ ...p[0], active_correction_id: 9 }]), base);
  });
});

describe("validation", () => {
  const u = build(fakeRepo());
  const bad = async (patch, re) => assert.rejects(u.preview({ ...INPUT, ...patch }, ADMIN), re);

  it("refuses a zero, fractional or oversized offset - the offset is never guessed", async () => {
    await bad({ offset_minutes: 0 }, /non-zero/);
    await bad({ offset_minutes: 1.5 }, /whole/);
    await bad({ offset_minutes: 721 }, /at most 720/);
    await bad({ offset_minutes: undefined }, /offset_minutes/);
  });

  it("refuses a reversed window, a future date, an unknown device, a missing remark or an unknown reason", async () => {
    await bad({ from_time: "09:00", to_time: "08:00" }, /must not be after/);
    await bad({ date: "2026-09-28" }, /future/);
    await bad({ biomax_device_id: 99 }, /No registered attendance device/);
    await bad({ remarks: "  " }, /remarks/);
    await bad({ reason_code: "EMPLOYEE_FORGOT" }, /reason_code must be one of/);
  });

  it("refuses an outlet the device was not assigned to during the window", async () => {
    await bad({ outlet_id: 10 }, /was not assigned to outlet 10/);
  });
});

describe("administrators only", () => {
  const u = build(fakeRepo({ punches: [punch(1, 501, `${DATE} 06:42:15`)] }));
  for (const actor of [null, { employee_id: 5, user_type: 1 }, { employee_id: 5, user_type: 3 }]) {
    it(`refuses user_type ${actor ? actor.user_type : "none"} on every entry point`, async () => {
      for (const call of [
        () => u.preview(INPUT, actor),
        () => u.apply({ ...INPUT, batch_ref: "00000000-0000-4000-8000-000000000000", preview_fingerprint: "a".repeat(64) }, actor),
        () => u.revert({ correction_id: 1, reason: "because" }, actor),
        () => u.list({}, actor),
        () => u.get(1, actor),
        () => u.options(actor),
      ]) {
        await assert.rejects(call(), (err) => err.httpCode === 403 && err.code === "ADMIN_ONLY");
      }
    });
  }
});

describe("preview", () => {
  it("14. calls no writer, and returns the summary and the table", async () => {
    const repo = fakeRepo({
      punches: [punch(1, 501, `${DATE} 06:42:15`), punch(2, 502, `${DATE} 06:30:00`), punch(3, 502, `${DATE} 08:30:00`)],
    });
    const calc = fakeCalc();
    const result = await build(repo, calc).preview(INPUT, ADMIN);
    assert.equal(repo.writes().length, 0);
    assert.equal(calc.calls.length, 0, "not even a calculation");
    assert.equal(result.can_apply, true);
    assert.equal(result.summary.punch_count, 3);
    assert.equal(result.summary.employee_count, 2);
    assert.equal(result.summary.earliest_original, `${DATE} 06:30:00`);
    assert.equal(result.summary.earliest_corrected, `${DATE} 09:00:00`);
    assert.equal(result.summary.latest_original, `${DATE} 08:30:00`);
    assert.equal(result.summary.latest_corrected, `${DATE} 11:00:00`);
    assert.match(result.batch_ref, /^[0-9a-f-]{36}$/);
    assert.match(result.preview_fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(result.punches[0]).slice(0, 6), [
      "biomax_punch_id", "employee_id", "employee_code", "employee_name", "original_punch", "corrected_punch",
    ]);
  });

  it("blocks a correction that would move a punch off the selected date", async () => {
    const repo = fakeRepo({ punches: [punch(1, 501, `${DATE} 23:30:00`)] });
    const result = await build(repo).preview({ ...INPUT, from_time: "23:00", to_time: "23:59", offset_minutes: 60 }, ADMIN);
    assert.equal(result.can_apply, false);
    assert.equal(result.blocking_issues[0].code, "CROSSES_DATE");
  });

  it("blocks when nothing matches", async () => {
    const result = await build(fakeRepo()).preview(INPUT, ADMIN);
    assert.equal(result.can_apply, false);
    assert.equal(result.blocking_issues[0].code, "NO_PUNCHES");
  });
});

describe("apply and revert through the usecase", () => {
  it("apply stores the corrected times it previewed, with the recalculated rows, in one repository call", async () => {
    const punches = [punch(1, 501, `${DATE} 06:42:15`)];
    const repo = fakeRepo({ punches });
    const calc = fakeCalc();
    const u = build(repo, calc);
    const p = await u.preview(INPUT, ADMIN);
    const result = await u.apply({ ...INPUT, batch_ref: p.batch_ref, preview_fingerprint: p.preview_fingerprint }, ADMIN);
    assert.equal(result.status, "APPLIED");
    const [write] = repo.writes();
    assert.equal(write.name, "applyCorrection");
    assert.deepEqual(write.args.items, [{
      biomax_punch_id: 1, employee_id: 501, original_io_time: `${DATE} 06:42:15`,
      corrected_io_time: `${DATE} 09:12:15`, offset_minutes: 150,
    }]);
    assert.deepEqual(write.args.calculation_rows, [{ employee_id: 501, attendance_date: DATE }]);
    assert.deepEqual(write.args.lock_rows, [{ employee_id: 501, attendance_date: DATE }]);
    assert.equal(write.args.batch.applied_by_employee_id, 900);
    // 8. the recalculation was asked to assume the CORRECTED time.
    assert.equal(calc.calls[0].assume_io_times.get("1"), `${DATE} 09:12:15`);
  });

  it("10. a locked month refuses apply before any write", async () => {
    const repo = fakeRepo({ punches: [punch(1, 501, `${DATE} 06:42:15`)] });
    const u = build(repo, fakeCalc({ locked: [{ employee_id: 501, year: 2026, month: 9 }] }));
    const p = await u.preview(INPUT, ADMIN);
    assert.equal(p.can_apply, false);
    await assert.rejects(
      u.apply({ ...INPUT, batch_ref: p.batch_ref, preview_fingerprint: p.preview_fingerprint }, ADMIN),
      (err) => err.code === "PAYROLL_MONTH_LOCKED" && /approved and locked/.test(err.message)
    );
    assert.equal(repo.writes().length, 0);
  });

  it("11-12. revert assumes the ORIGINAL times; a locked month refuses it before any write", async () => {
    const batch = {
      attendance_device_time_correction_id: 4, status: "APPLIED", correction_date: DATE,
      punches: [{ biomax_punch_id: 1, employee_id: 501, original_io_time: `${DATE} 06:42:15`, corrected_io_time: `${DATE} 09:12:15`, is_active: 1 }],
    };
    const locked = fakeRepo({ batch });
    await assert.rejects(
      build(locked, fakeCalc({ locked: [{ employee_id: 501, year: 2026, month: 9 }] })).revert({ correction_id: 4, reason: "wrong offset" }, ADMIN),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal(locked.writes().length, 0);

    const repo = fakeRepo({ batch });
    const calc = fakeCalc();
    await build(repo, calc).revert({ correction_id: 4, reason: "wrong offset" }, ADMIN);
    assert.equal(calc.calls[0].assume_io_times.get("1"), `${DATE} 06:42:15`);
    assert.deepEqual(repo.writes()[0].args.expected_active_punch_ids, [1]);
  });

  it("a reverted batch cannot be reverted again", async () => {
    const repo = fakeRepo({ batch: { attendance_device_time_correction_id: 4, status: "REVERTED", punches: [] } });
    await assert.rejects(
      build(repo).revert({ correction_id: 4, reason: "again please" }, ADMIN),
      (err) => err.code === "ALREADY_REVERTED" && err.httpCode === 409
    );
  });
});

describe("the route", () => {
  const serve = async (decoded, usecase) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.decoded = decoded;
      next();
    });
    app.use("/", buildRoutes(usecase).getRouter());
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      post: (path, body) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      get: (path) => fetch(`${base}${path}`),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  };
  const recorder = () => {
    const calls = [];
    const fn = (name) => async (...args) => {
      calls.push(name);
      return { code: 200, name };
    };
    return { calls, preview: fn("preview"), apply: fn("apply"), revert: fn("revert"), list: fn("list"), get: fn("get"), options: fn("options") };
  };

  it("403s a non-administrator on every route before the usecase runs, with error ADMIN_ONLY", async () => {
    const u = recorder();
    const s = await serve({ id: 3, employee_id: 5, user_type: 1 }, u);
    try {
      for (const r of [
        s.get("/attendance/device-time-corrections/options"),
        s.post("/attendance/device-time-corrections/preview", INPUT),
        s.post("/attendance/device-time-corrections", INPUT),
        s.get("/attendance/device-time-corrections"),
        s.get("/attendance/device-time-corrections/1"),
        s.post("/attendance/device-time-corrections/1/revert", { reason: "because" }),
      ]) {
        const res = await r;
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error, "ADMIN_ONLY");
      }
      assert.deepEqual(u.calls, []);
    } finally {
      await s.close();
    }
  });

  it("refuses a client-supplied punch id, corrected time or actor", async () => {
    const u = recorder();
    const s = await serve({ id: 7, employee_id: 900, user_type: 2 }, u);
    try {
      for (const extra of [{ biomax_punch_ids: [1] }, { corrected_io_time: "2026-09-25 09:00:00" }, { applied_by_employee_id: 1 }]) {
        const res = await s.post("/attendance/device-time-corrections/preview", { ...INPUT, ...extra });
        assert.equal(res.status, 400);
      }
      const ok = await s.post("/attendance/device-time-corrections/preview", INPUT);
      assert.equal(ok.status, 200);
      const noToken = await s.post("/attendance/device-time-corrections", INPUT);
      assert.equal(noToken.status, 400, "apply needs the batch_ref and fingerprint from Preview");
      assert.deepEqual(u.calls, ["preview"]);
    } finally {
      await s.close();
    }
  });
});
