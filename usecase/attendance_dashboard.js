const {
  CALC_STATUS,
  PUNCH_SOURCE,
  calculateAttendanceDay,
  attendanceDateForPunch,
  addDays,
  dayDelta,
} = require("../utils/attendance_engine");
const { RESOLUTION_STATUS, resolveShiftForDate, toDateOnly } = require("../utils/shiftResolution");
const {
  resolveConfigVersionForDate,
  toShiftDefinition,
  VERSIONED_CONFIG_COLUMNS,
} = require("../utils/shift_config_version");
const { resolveEffectiveRawPunches } = require("../utils/attendance_effective_punches");
const {
  COVERAGE,
  COVERAGE_LABEL,
  ISSUE_KEY,
  ISSUE_LABEL,
  NEED_ACTION_ISSUE_KEYS,
  PRESENCE_SLICE,
  PRESENCE_SLICE_LABEL,
  PRESENCE_SLICE_ORDER,
  CHECK_IN_RATE_DEFINITION,
  dashboardIssueKey,
  dayCloseMinute,
  hasShiftStarted,
  isDayClosed,
  istNowParts,
  locationCoverage,
  nowOnDateAxis,
  presenceSlice,
  rate,
  tallyBy,
  timeMinutes,
  unresolvedReason,
} = require("../utils/attendance_dashboard");

/**
 * Attendance Dashboard - the orchestration.
 *
 * WHAT THIS IS. A read-only management OVERVIEW of one attendance date: six
 * counts, six panels, and a drilldown behind each. It is an ADDITIONAL view,
 * not a replacement for the per-employee monthly screen, and it is not a
 * second attendance or payroll engine.
 *
 * THE ENGINE REMAINS THE SOURCE OF TRUTH, and this file proves it by calling
 * it. Every number below is derived from `calculateAttendanceDay` over the
 * same effective punch stream, the same dated shift resolution and the same
 * dated configuration version that `usecase/attendance_calculation.js` feeds
 * it. There is no aggregate SQL that counts attendance by itself, because a
 * COUNT(*) with a hand-written WHERE clause would be a second definition of
 * "present" that could disagree with the employee's own screen.
 *
 * WHY IT DOES NOT SIMPLY CALL `calculateRange` PER EMPLOYEE. Because
 * `buildContext` there issues six queries per employee: right for one
 * person's month, and 1,800 round trips for three hundred people on one date.
 * So the FETCHING is batched here (`repository/attendance_dashboard.js`, one
 * read per kind for the whole population) and the PURE functions are reused
 * unchanged. `attendance_dashboard_parity.test.js` calculates the same
 * employee and date through both paths and asserts the days come out
 * identical, so this batching can never drift into a different answer.
 *
 * IT WRITES NOTHING AND RECALCULATES NOTHING. Days are computed in memory and
 * thrown away. No row of `attendance_day_calculation`,
 * `attendance_monthly_payroll`, `biomax_punch` or any approval table is
 * inserted, updated or deleted by opening this screen, and no OT request is
 * created: the repository has no write method to call. Loading a dashboard
 * must never move a payroll figure.
 *
 * AN OPEN DAY IS NOT A FINALIZED DAY, and the two are never mixed. Today's
 * observed headcount is exactly that - observed, provisional, and labelled as
 * such. Confirmed absence and confirmed missing punches are reported only for
 * an attendance date that has CLOSED under its own shift's cutoff (see
 * `utils/attendance_dashboard.js`), which is also why the trend chart plots
 * COMPLETED days only.
 *
 * NOTHING SENSITIVE IS RETURNED. The repository never selects a salary, bank,
 * PAN, PF/ESI or Aadhaar column, and the rows shaped here carry an employee's
 * id, name, outlet, designation and attendance only. A dashboard about who is
 * at work is not a reason to widen anybody's access to pay data.
 */

/** The widest window the trend may ask for. A month plus a few days. */
const MAX_TREND_DAYS = 35;

/** The trend's default: the last fourteen COMPLETED attendance days. */
const DEFAULT_TREND_DAYS = 14;

/** Beyond this the dashboard refuses rather than melting the pool. */
const MAX_POPULATION = 2000;

/** Drilldown page size ceiling. Lists are paginated, never unbounded. */
const MAX_DRILLDOWN_LIMIT = 200;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** Every date from `from` to `to` inclusive. Bounded by the caller. */
function dateRange(from, to, max = MAX_TREND_DAYS) {
  const dates = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard <= max) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

/** The employee's Special Break Duration Override, or null. Same rule as A1. */
function breakOverrideMinutes(row) {
  if (!row) return null;
  const value = row.special_break_override_minutes;
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/** `biomax_punch.ingest_source` -> the engine's source. Same map as A1. */
const rawSource = (ingestSource) =>
  ingestSource === "DIGISME_IMPORT" || ingestSource === "IMPORT"
    ? PUNCH_SOURCE.IMPORT
    : PUNCH_SOURCE.BIOMAX;

/** Group rows into a Map keyed by a field, preserving order. */
function groupBy(rows, keyOf) {
  const out = new Map();
  (rows || []).forEach((row) => {
    const key = keyOf(row);
    if (key === null || key === undefined) return;
    const k = String(key);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  });
  return out;
}

module.exports = (attendanceDashboardRepo) => {
  /**
   * Every shift's definition - live row, weekly schedule and effective-dated
   * configuration versions - in three reads, keyed by shift id.
   *
   * `withLiveDefaults` is the same rule `usecase/attendance_calculation.js`
   * applies: a version document written before a column was versioned lacks
   * the key altogether, and such a column was never recorded rather than
   * being zero, so the LIVE row supplies only the ABSENT keys. A value the
   * version does carry - including 0 - is what that date calculates under.
   */
  const withLiveDefaults = (definition, live) => {
    const liveConfig = live && live.config ? live.config : null;
    if (!definition || !liveConfig) return definition;
    const config = { ...definition.config };
    VERSIONED_CONFIG_COLUMNS.forEach((column) => {
      if (config[column] === undefined && liveConfig[column] !== undefined) {
        config[column] = liveConfig[column];
      }
    });
    return { ...definition, config };
  };

  const loadShiftCache = async () => {
    const [configs, schedules, versions] = await Promise.all([
      attendanceDashboardRepo.listWorkShiftConfigs(),
      attendanceDashboardRepo.listWorkShiftSchedules(),
      attendanceDashboardRepo.listWorkShiftConfigVersions(),
    ]);

    const schedulesByShift = groupBy(schedules, (r) => r.work_shift_id);
    const versionsByShift = groupBy(versions, (r) => r.work_shift_id);

    const cache = new Map();
    (configs || []).forEach((config) => {
      const id = Number(config.work_shift_id);
      cache.set(id, {
        live: { config, schedule: schedulesByShift.get(String(id)) || [] },
        versions: versionsByShift.get(String(id)) || [],
      });
    });
    // A shift with versions but no live row is still resolvable for a
    // historical date, so it is not dropped.
    versionsByShift.forEach((rows, key) => {
      const id = Number(key);
      if (!cache.has(id)) cache.set(id, { live: null, versions: rows });
    });
    return cache;
  };

  /**
   * The per-employee readers the PURE resolvers consume, built over the
   * batched reads.
   *
   * One closure per employee, each holding only that employee's assignment
   * history and overrides, so `resolveShiftForDate` sees exactly what it sees
   * on the single-employee path. Resolutions and definitions are memoized per
   * employee because a fourteen-day trend resolves the same (shift, date) pair
   * repeatedly.
   */
  const employeeResolver = ({ shiftCache, assignments, overrides }) => {
    const definitions = new Map();
    const definitionFor = (workShiftId, date) => {
      const key = `${workShiftId}|${date}`;
      if (definitions.has(key)) return definitions.get(key);
      const loaded = shiftCache.get(Number(workShiftId));
      let definition = null;
      if (loaded) {
        const versionRow = resolveConfigVersionForDate(loaded.versions, date);
        definition = versionRow
          ? withLiveDefaults(toShiftDefinition(versionRow, workShiftId), loaded.live)
          : loaded.live
          ? {
              ...loaded.live,
              config_version_id: null,
              config_version_hash: null,
              config_effective_from: null,
              from_live: true,
            }
          : null;
      }
      definitions.set(key, definition);
      return definition;
    };

    const readSchedule = (workShiftId, dow, date) => {
      const definition = definitionFor(workShiftId, date);
      if (!definition) return null;
      return definition.schedule.find((row) => Number(row.day_of_week) === Number(dow)) || null;
    };

    const readShiftConfig = (workShiftId, date) => {
      const definition = definitionFor(workShiftId, date);
      if (!definition) return null;
      return {
        ...definition.config,
        config_version_id: definition.config_version_id || null,
        config_version_hash: definition.config_version_hash || null,
        config_effective_from: definition.config_effective_from || null,
      };
    };

    const resolutions = new Map();
    const resolutionFor = (date) => {
      if (resolutions.has(date)) return resolutions.get(date);
      const resolution = resolveShiftForDate({
        assignments,
        overrides,
        attendanceDate: date,
        readSchedule,
        readShiftConfig,
      });
      resolutions.set(date, resolution);
      return resolution;
    };

    /** The cutoff that applied on a date, for RE-DATING a punch. Same as A1. */
    const readCutoff = (date) => {
      const resolution = resolutionFor(date);
      if (!resolution || !resolution.snapshot) return null;
      return {
        is_working_day: resolution.snapshot.is_working_day,
        attendance_day_cutoff: resolution.snapshot.attendance_day_cutoff,
      };
    };

    const shiftNameFor = (workShiftId) => {
      const loaded = shiftCache.get(Number(workShiftId));
      const config = loaded && loaded.live ? loaded.live.config : null;
      return config && config.shift_name ? config.shift_name : null;
    };

    const shiftCodeFor = (workShiftId) => {
      const loaded = shiftCache.get(Number(workShiftId));
      const config = loaded && loaded.live ? loaded.live.config : null;
      return config && config.shift_code ? config.shift_code : null;
    };

    return { resolutionFor, readCutoff, shiftNameFor, shiftCodeFor };
  };

  /**
   * THE EFFECTIVE RAW STREAM, then the grouping by attendance date - for ONE
   * employee, with the same five steps and the same order as A1's
   * `groupRawPunchesByAttendanceDate`:
   *
   *   1. raw BIOMAX + IMPORT punches as one chronological stream by absolute
   *      instant, so a midnight crossing resets nothing;
   *   2. manually VOIDED punches removed;
   *   3. a punch ten minutes or less after the last KEPT one IGNORED as a
   *      duplicate - which is what makes "Checked In" a count of DISTINCT
   *      employees with a real punch rather than a count of frames received;
   *   4. the kept punches re-dated to their attendance day and grouped;
   *   5. approved regularized punches join per date in `computeDays`.
   */
  const groupRawPunches = ({ rawPunches, readCutoff, from, to }) => {
    const shaped = (rawPunches || []).map((punch) => ({
      punch_id: punch.punch_id,
      source: rawSource(punch.ingest_source),
      dev_id: punch.dev_id,
      io_time: punch.io_time,
      ingest_attendance_date: punch.ingest_attendance_date || null,
      attendance_punch_void_id: punch.attendance_punch_void_id || null,
      void_reason: punch.void_reason === undefined ? null : punch.void_reason,
    }));

    const { all } = resolveEffectiveRawPunches(shaped);

    const byDate = new Map();
    const excludedByDate = new Map();
    all.forEach((punch) => {
      const derived = attendanceDateForPunch({ ioTime: punch.io_time, readCutoff });
      if (derived === null || derived < from || derived > to) return;
      const { attendance_punch_void_id, void_reason, ...rest } = punch;
      const row = { ...rest, attendance_date: derived };
      const target = punch.effective_status === "USED" ? byDate : excludedByDate;
      if (!target.has(derived)) target.set(derived, []);
      target.get(derived).push(row);
    });
    return { byDate, excludedByDate };
  };

  /**
   * Everything the dashboard needs for a population over a date range, in a
   * fixed number of reads regardless of how many employees are in scope.
   */
  const loadBatch = async ({ employees, from, to }) => {
    const employeeIds = employees.map((e) => Number(e.employee_id));
    // ONE day of slack at each end, for exactly the two reasons A1 states:
    // at the END because a punch on the following morning can belong to `to`,
    // and at the START because whether the first punch of `from` is a
    // duplicate depends on the last kept punch before it.
    const punchFrom = addDays(from, -1);
    const punchTo = addDays(to, 1);

    const [shiftCache, assignments, overrides, rawPunches, regularized, approvals] =
      await Promise.all([
        loadShiftCache(),
        attendanceDashboardRepo.getShiftAssignmentHistoryForEmployees(employeeIds),
        attendanceDashboardRepo.getDateShiftOverridesForEmployees(employeeIds, from, punchTo),
        attendanceDashboardRepo.getRawPunchesForEmployees(employeeIds, punchFrom, punchTo),
        attendanceDashboardRepo.getApprovedRegularizedPunchesForEmployees(employeeIds, from, to),
        attendanceDashboardRepo.getApprovalStateForEmployees(employeeIds, from, to),
      ]);

    return {
      shiftCache,
      assignmentsByEmployee: groupBy(assignments, (r) => r.employee_id),
      overridesByEmployee: groupBy(overrides, (r) => r.employee_id),
      rawByEmployee: groupBy(rawPunches, (r) => r.employee_id),
      regularizedByEmployee: groupBy(regularized, (r) => r.employee_id),
      approvalsByEmployee: groupBy(approvals, (r) => r.employee_id),
    };
  };

  /**
   * One employee x one date range -> engine days, exactly as `calculateRange`
   * produces them.
   *
   * The approval slotting, the settled-approval rule and the OT separation
   * below are transcribed from `usecase/attendance_calculation.js` and must
   * stay that way; the parity test is what enforces it. In particular:
   *
   *   - only a SETTLED approval is payroll-effective, so an APPROVED request
   *     whose day was never recalculated holds the date rather than paying OT
   *     against stale attendance;
   *   - a PENDING regularization makes the day REGULARIZATION_PENDING, which
   *     is how the day reaches Need Action;
   *   - OT is a claim on a day, never an attendance defect: it is reported
   *     beside the day and never changes its status or its bucket.
   */
  const computeDaysForEmployee = ({ employee, dates, batch }) => {
    const key = String(employee.employee_id);
    const resolver = employeeResolver({
      shiftCache: batch.shiftCache,
      assignments: batch.assignmentsByEmployee.get(key) || [],
      overrides: batch.overridesByEmployee.get(key) || [],
    });

    const from = dates[0];
    const to = dates[dates.length - 1];
    const { byDate, excludedByDate } = groupRawPunches({
      rawPunches: batch.rawByEmployee.get(key) || [],
      readCutoff: resolver.readCutoff,
      from,
      to,
    });

    const regularizedByDate = groupBy(
      batch.regularizedByEmployee.get(key) || [],
      (r) => toDateOnly(r.attendance_date)
    );

    const approvalByDate = new Map();
    (batch.approvalsByEmployee.get(key) || []).forEach((row) => {
      const date = toDateOnly(row.attendance_date);
      if (!approvalByDate.has(date)) approvalByDate.set(date, { regularization: null, ot: null });
      const slot = approvalByDate.get(date);
      if (row.request_type === "OT") slot.ot = row;
      else slot.regularization = row;
    });

    const isSettled = (row) =>
      !!row &&
      row.status === "APPROVED" &&
      (row.finalization_state === undefined ||
        row.finalization_state === null ||
        row.finalization_state === "SETTLED");

    return dates.map((date) => {
      const resolution = resolver.resolutionFor(date);
      const slots = approvalByDate.get(date) || { regularization: null, ot: null };
      const approval = slots.regularization;
      const otRequest = slots.ot;

      const regularizationSettled = isSettled(approval);
      const otSettled = isSettled(otRequest);

      const approvedOt = otSettled
        ? Number(otRequest.approved_ot_minutes || 0)
        : regularizationSettled && approval.request_type === "REGULARIZATION_WITH_OT"
        ? Number(approval.approved_ot_minutes || 0)
        : 0;

      const stillOpen =
        !!approval &&
        (approval.status === "PENDING" ||
          (approval.status === "APPROVED" && !regularizationSettled));

      const calculated = calculateAttendanceDay({
        employee_id: Number(employee.employee_id),
        attendance_date: date,
        shift: resolution.snapshot,
        shift_status: resolution.status,
        punches: byDate.get(date) || [],
        excluded_punches: excludedByDate.get(date) || [],
        regularized_punches: (regularizedByDate.get(date) || []).map((p) => ({
          punch_id: p.punch_id === undefined ? null : p.punch_id,
          source: PUNCH_SOURCE.REGULARIZED,
          io_time: p.io_time,
        })),
        break_override_minutes: breakOverrideMinutes(employee),
        approved_ot_minutes: approvedOt,
        regularization_pending: stillOpen,
      });

      return {
        ...calculated,
        shift_resolution_status: resolution.status,
        work_shift_id: resolution.work_shift_id,
        shift_name: resolution.work_shift_id
          ? resolver.shiftNameFor(resolution.work_shift_id)
          : null,
        shift_code: resolution.work_shift_id
          ? resolver.shiftCodeFor(resolution.work_shift_id)
          : null,
        shift_source: resolution.assignment ? resolution.assignment.source || null : null,
        // The OT CLAIM, kept strictly beside the attendance status. A pending
        // OT request never moves a normal day into Need Action.
        ot_request_id: otRequest ? otRequest.attendance_approval_request_id : null,
        ot_request_pending:
          !!otRequest &&
          (otRequest.status === "PENDING" ||
            (otRequest.status === "APPROVED" && !otSettled)),
        ot_requested_minutes: otRequest ? Number(otRequest.candidate_ot_minutes || 0) : null,
        regularization_request_id: approval ? approval.attendance_approval_request_id : null,
      };
    });
  };

  /* ------------------------------------------------ delivery coverage */

  /** One key for "this employee's outlet", including the no-outlet case. */
  const outletKeyOf = (storeId) =>
    storeId === null || storeId === undefined ? "none" : String(storeId);

  /**
   * Coverage inputs for a whole date RANGE, read once.
   *
   * `last_seen_at` is a single CURRENT value per device, so one read answers
   * every date in the window: a device that has been in contact since a past
   * day closed has had the chance to hand over anything it buffered for that
   * day. The assignments come back with their own effective windows so the
   * per-date question - which terminals served this outlet THEN - is answered
   * from memory rather than with a query per day.
   *
   * A failure is UNKNOWN, not COMPLETE: `available: false` makes every date
   * withhold absence.
   */
  const loadRangeCoverageInputs = async ({ from, to, store_ids }) => {
    try {
      const [assignments, pulls] = await Promise.all([
        attendanceDashboardRepo.listDeviceCoverageForRange
          ? attendanceDashboardRepo.listDeviceCoverageForRange({
              from_date: from,
              to_date: to,
              store_ids,
            })
          : [],
        attendanceDashboardRepo.listOpenHistoricalPullsForRange
          ? attendanceDashboardRepo.listOpenHistoricalPullsForRange({
              from_date: from,
              to_date: to,
              store_ids,
            })
          : [],
      ]);
      return { assignments: assignments || [], pulls: pulls || [], available: true };
    } catch (err) {
      return { assignments: [], pulls: [], available: false };
    }
  };

  /** `YYYY-MM-DD HH:MM:SS` -> is it at or before the END of `date`? */
  const startsOnOrBefore = (value, date) => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
    return m ? m[1] <= date : false;
  };
  /** An assignment's exclusive end: still in force on `date`? */
  const endsAfter = (value, date) => {
    if (value === null || value === undefined || value === "") return true;
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
    return m ? m[1] > date : true;
  };

  /**
   * The per-outlet coverage verdict for ONE date of a range, from inputs
   * already in memory.
   *
   * Only the outlets the day's own population actually sits in are judged: a
   * silent terminal at a branch nobody on this filtered list works at says
   * nothing about this day's figures.
   */
  const coverageForDate = ({ date, rows, inputs }) => {
    const outletKeys = [...new Set((rows || []).map((r) => outletKeyOf(r.store_id)))];
    const byOutlet = new Map();

    if (!inputs.available) {
      outletKeys.forEach((k) => byOutlet.set(k, COVERAGE.UNKNOWN));
      return { byOutlet, allComplete: outletKeys.length === 0 };
    }

    // The close instant for each outlet on this date: the LATEST among the
    // shifts its people were rostered on, because the location's window is not
    // over until its last shift's cutoff has passed.
    const closeByOutlet = new Map();
    (rows || []).forEach((r) => {
      const key = outletKeyOf(r.store_id);
      const close = dayCloseMinute(r.snapshot);
      const current = closeByOutlet.get(key);
      if (current === undefined || close > current) closeByOutlet.set(key, close);
    });

    const devicesByOutlet = new Map();
    inputs.assignments.forEach((a) => {
      if (!startsOnOrBefore(a.effective_from, date)) return;
      if (!endsAfter(a.effective_to, date)) return;
      const key = outletKeyOf(a.outlet_id);
      if (!devicesByOutlet.has(key)) devicesByOutlet.set(key, []);
      devicesByOutlet.get(key).push({
        ...a,
        last_seen_minute:
          a.last_seen_at === null || a.last_seen_at === undefined
            ? null
            : minuteOnDateAxis(date, a.last_seen_at),
      });
    });

    const openForOutlet = new Set();
    let unattributedPull = false;
    inputs.pulls.forEach((p) => {
      // Does this pull actually cover THIS date?
      if (!startsOnOrBefore(p.requested_from, date)) return;
      const toM = /^(\d{4}-\d{2}-\d{2})/.exec(String(p.requested_to || ""));
      if (toM && toM[1] < date) return;
      if (p.outlet_id === null || p.outlet_id === undefined) unattributedPull = true;
      else openForOutlet.add(outletKeyOf(p.outlet_id));
    });

    outletKeys.forEach((key) => {
      byOutlet.set(
        key,
        locationCoverage({
          devices: devicesByOutlet.get(key) || [],
          close_minute: closeByOutlet.get(key),
          open_pull: unattributedPull || openForOutlet.has(key),
        })
      );
    });

    return {
      byOutlet,
      allComplete:
        outletKeys.length > 0 && outletKeys.every((k) => byOutlet.get(k) === COVERAGE.COMPLETE),
    };
  };


  /**
   * DELIVERY COVERAGE per outlet for one attendance date.
   *
   * Answers "have the punches for this window actually reached us", which the
   * cutoff passing does NOT answer. Built from two existing facts and nothing
   * invented:
   *
   *   - every terminal mapped to that outlet ON THAT DATE, and the last moment
   *     the receiver heard from it (`biomax_device.last_seen_at`, written on
   *     any contact including polls);
   *   - any historical pull still running that covers the date, which is a
   *     positive statement that punches are still being retrieved.
   *
   * The comparison is against the attendance day's OWN close instant - the one
   * the shift's cutoff already defines - so there is no "stale after N
   * minutes" threshold anywhere in it.
   *
   * A READ FAILURE IS UNKNOWN, NOT COMPLETE. If either query throws, every
   * outlet comes back UNKNOWN and every no-punch day stays provisional. The
   * safe direction is to under-claim absence.
   *
   * @returns {{byOutlet: Map<string,string>, available: boolean, devices: Array}}
   */
  const resolveCoverage = async ({ date, store_ids, closeMinuteByOutlet, now }) => {
    let devices = [];
    let pulls = [];
    let available = true;
    try {
      [devices, pulls] = await Promise.all([
        attendanceDashboardRepo.listDeviceCoverageForDate
          ? attendanceDashboardRepo.listDeviceCoverageForDate({ attendance_date: date, store_ids })
          : [],
        attendanceDashboardRepo.listOpenHistoricalPullsForDate
          ? attendanceDashboardRepo.listOpenHistoricalPullsForDate({ attendance_date: date, store_ids })
          : [],
      ]);
    } catch (err) {
      // Deliberately swallowed into UNKNOWN rather than failing the page: the
      // headcounts are still worth showing, and the honest consequence of not
      // knowing is that absence is withheld, which is what UNKNOWN does.
      available = false;
      devices = [];
      pulls = [];
    }

    const devicesByOutlet = new Map();
    (devices || []).forEach((d) => {
      const key = outletKeyOf(d.outlet_id);
      if (!devicesByOutlet.has(key)) devicesByOutlet.set(key, []);
      devicesByOutlet.get(key).push({
        ...d,
        // The device's last contact, on the attendance date's own minute axis,
        // so it is directly comparable with the day's close minute.
        last_seen_minute: d.last_seen_at === null || d.last_seen_at === undefined
          ? null
          : minuteOnDateAxis(date, d.last_seen_at),
      });
    });

    const openPullOutlets = new Set(
      (pulls || []).filter((p) => p.outlet_id !== null && p.outlet_id !== undefined)
        .map((p) => outletKeyOf(p.outlet_id))
    );
    // A running pull whose device has no current outlet assignment cannot be
    // attributed to a branch, so it clouds every outlet rather than none: we
    // do not know which location's punches are still coming.
    const unattributedPull = (pulls || []).some(
      (p) => p.outlet_id === null || p.outlet_id === undefined
    );

    const byOutlet = new Map();
    closeMinuteByOutlet.forEach((closeMinute, key) => {
      if (!available) {
        byOutlet.set(key, COVERAGE.UNKNOWN);
        return;
      }
      byOutlet.set(
        key,
        locationCoverage({
          devices: devicesByOutlet.get(key) || [],
          close_minute: closeMinute,
          open_pull: unattributedPull || openPullOutlets.has(key),
        })
      );
    });

    return { byOutlet, available, devices: devices || [], pulls: pulls || [] };
  };

  /**
   * A `YYYY-MM-DD HH:MM:SS` instant expressed on an attendance date's minute
   * axis, the same axis `nowOnDateAxis` puts "now" on. Null when unreadable.
   */
  const minuteOnDateAxis = (attendanceDate, value) => {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(value || ""));
    if (!m) return null;
    const delta = dayDelta(attendanceDate, m[1]);
    if (delta === null) return null;
    return delta * 1440 + Number(m[2]) * 60 + Number(m[3]);
  };

  /* ------------------------------------------------------- the population */

  /**
   * The applicable population for a date, with the filters applied, plus the
   * per-employee engine day and its dashboard classification.
   *
   * THE SHIFT FILTER IS APPLIED AFTER RESOLUTION, not in SQL. Which shift
   * somebody was on for a date is the A0 dated history's answer, not
   * `new_employee.default_work_shift_id` - filtering in the query would use
   * today's assignment to filter a historical date, which is the exact defect
   * `utils/shiftResolution.js` exists to prevent.
   */
  const buildPopulation = async ({
    attendance_date,
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    now = Date.now(),
  }) => {
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    // AN EMPTY AUTHORIZED SCOPE IS NOT AN EMPTY FILTER. The caller may read
    // no location, so there is nothing to query - short-circuiting here means
    // the request never reaches the database at all, and the repository's own
    // `1 = 0` backstop is never even needed.
    if (Array.isArray(store_ids) && store_ids.length === 0) {
      return { date, rows: [], employees: [], coverage: new Map(), coverage_available: true };
    }

    const employees = await attendanceDashboardRepo.listApplicableEmployees({
      attendance_date: date,
      store_ids,
      designation_id,
      search,
    });

    if ((employees || []).length > MAX_POPULATION) {
      throw validationError(
        `${employees.length} employees match; narrow the filters to at most ${MAX_POPULATION}`
      );
    }
    if (!employees || employees.length === 0) {
      return { date, rows: [], employees: [], coverage: new Map(), coverage_available: true };
    }

    const batch = await loadBatch({ employees, from: date, to: date });

    // PASS ONE: the engine day per employee, plus the clock facts that depend
    // only on their own shift. Coverage needs the close instants first, so the
    // slice is decided in pass two.
    const partial = [];
    employees.forEach((employee) => {
      const [day] = computeDaysForEmployee({ employee, dates: [date], batch });
      if (work_shift_id !== null && Number(day.work_shift_id) !== Number(work_shift_id)) return;
      partial.push({ employee, day });
    });

    // THE CLOSE INSTANT PER OUTLET is the LATEST close among the employees
    // rostered there: the location's window is not over until its last shift's
    // cutoff has passed, so a 9-9 terminal is not asked to vouch for a 2-10
    // night that is still running.
    const closeMinuteByOutlet = new Map();
    partial.forEach(({ employee, day }) => {
      const key = outletKeyOf(employee.store_id);
      const close = dayCloseMinute(day.shift_snapshot || null);
      const current = closeMinuteByOutlet.get(key);
      if (current === undefined || close > current) closeMinuteByOutlet.set(key, close);
    });

    const coverage = await resolveCoverage({ date, store_ids, closeMinuteByOutlet, now });

    // PASS TWO: the slice, now that each employee's location has a verdict.
    const rows = partial.map(({ employee, day }) => {
      const outletKey = outletKeyOf(employee.store_id);
      const outletCoverage = coverage.byOutlet.get(outletKey) || COVERAGE.UNKNOWN;

      const dayClosed = isDayClosed({
        attendance_date: date,
        snapshot: day.shift_snapshot || null,
        now,
      });
      const shiftStarted = hasShiftStarted({
        attendance_date: date,
        snapshot: day.shift_snapshot || null,
        now,
      });
      const issueKey = dashboardIssueKey(day, {
        day_closed: dayClosed,
        coverage: outletCoverage,
      });
      const slice = presenceSlice({
        day,
        resolution_status: day.shift_resolution_status,
        day_closed: dayClosed,
        shift_started: shiftStarted,
        coverage: outletCoverage,
      });

      return {
        employee_id: Number(employee.employee_id),
        employee_name: employee.employee_name,
        store_id: employee.store_id === null ? null : Number(employee.store_id),
        outlet_name: employee.outlet_name || employee.outlet_nickname || null,
        designation_id: employee.designation_id === null ? null : Number(employee.designation_id),
        designation_name: employee.designation_name || null,
        work_shift_id: day.work_shift_id === null ? null : Number(day.work_shift_id),
        shift_name: day.shift_name,
        shift_code: day.shift_code,
        attendance_date: date,
        punch_count: Number(day.punch_count) || 0,
        first_punch: day.effective_punches && day.effective_punches.length
          ? day.effective_punches[0].io_time
          : null,
        last_punch: day.effective_punches && day.effective_punches.length
          ? day.effective_punches[day.effective_punches.length - 1].io_time
          : null,
        // THE PUNCHES THE ENGINE DATED TO THIS ATTENDANCE DAY, by id. The
        // punch feed is built from these rather than from a timestamp range,
        // so its membership is the shift's own cutoff rule and not an assumed
        // midnight boundary. Excluded ones are carried separately so they can
        // be shown for diagnosis and counted nowhere.
        punch_ids: (day.effective_punches || [])
          .filter((pn) => pn.source !== PUNCH_SOURCE.REGULARIZED)
          .map((pn) => pn.punch_id)
          .filter((id) => id !== null && id !== undefined),
        excluded_punch_ids: (day.excluded_punches || [])
          .map((pn) => pn.punch_id)
          .filter((id) => id !== null && id !== undefined),
        status: day.status,
        shift_resolution_status: day.shift_resolution_status,
        day_closed: dayClosed,
        shift_started: shiftStarted,
        // Delivery evidence for this employee's location, carried on the row so
        // the drilldown can say WHY a day is still unresolved.
        coverage: outletCoverage,
        coverage_label: COVERAGE_LABEL[outletCoverage],
        unresolved_reason: unresolvedReason({
          day,
          resolution_status: day.shift_resolution_status,
          day_closed: dayClosed,
          coverage: outletCoverage,
        }),
        issue_key: issueKey,
        issue_label: issueKey ? ISSUE_LABEL[issueKey] : null,
        need_action: issueKey !== null && NEED_ACTION_ISSUE_KEYS.includes(issueKey),
        slice,
        ot_request_id: day.ot_request_id,
        ot_request_pending: day.ot_request_pending,
        ot_requested_minutes: day.ot_requested_minutes,
        candidate_ot_minutes: Number(day.candidate_ot_minutes) || 0,
        regularization_request_id: day.regularization_request_id,
      };
    });

    return {
      date,
      rows,
      employees,
      coverage: coverage.byOutlet,
      coverage_available: coverage.available,
    };
  };

  /* ------------------------------------------------------------ the cards */

  /**
   * The six top cards.
   *
   * Each one is a count of DISTINCT EMPLOYEES over the same filtered
   * population, so no card can exceed Total Employees and two cards can never
   * disagree about who is in scope.
   *
   *   1 TOTAL EMPLOYEES     applicable to the date: joined on or before it and
   *                         not resigned before it. Never `new_employee.status`,
   *                         which is hand-maintained and would put old leavers
   *                         into a historical headcount.
   *   2 CHECKED IN          at least one VALID effective punch dated to the
   *                         day. This is "punched at some point during that
   *                         attendance day" - NOT currently on the premises,
   *                         and NOT a finalized payable Present Day. Duplicate
   *                         and voided punches are already gone, and approved
   *                         regularized punches count.
   *   3 NOT YET CHECKED IN  shift started, day still open, nothing punched.
   *                         Somebody whose shift has not begun is NOT here.
   *   4 ABSENT              the engine's ABSENT, and only after the day closed.
   *                         Never inferred from a missing row or a quiet feed.
   *   5 NEED ACTION         the four canonical issues. OT pending alone never
   *                         puts a day here.
   *   6 OT REQUESTS PENDING pending OT requests and the engine's own minutes
   *                         for them. A claim state, not an attendance state.
   */
  const buildCards = (rows) => {
    const distinct = (predicate) =>
      new Set(rows.filter(predicate).map((r) => r.employee_id)).size;

    const otPendingRows = rows.filter((r) => r.ot_request_pending);
    const otMinutes = otPendingRows.reduce(
      (sum, r) =>
        sum +
        Math.max(
          0,
          Math.trunc(
            Number(r.ot_requested_minutes === null ? r.candidate_ot_minutes : r.ot_requested_minutes) || 0
          )
        ),
      0
    );

    const total = distinct(() => true);
    const checkedIn = distinct((r) => r.punch_count > 0);

    return {
      total_employees: { count: total },
      checked_in: {
        count: checkedIn,
        rate: rate(checkedIn, total),
        definition: CHECK_IN_RATE_DEFINITION,
      },
      not_yet_checked_in: {
        count: distinct((r) => r.slice === PRESENCE_SLICE.NOT_YET_CHECKED_IN),
      },
      absent: { count: distinct((r) => r.slice === PRESENCE_SLICE.ABSENT) },
      need_action: {
        count: distinct((r) => r.need_action),
        by_issue: NEED_ACTION_ISSUE_KEYS.map((key) => ({
          key,
          label: ISSUE_LABEL[key],
          count: distinct((r) => r.issue_key === key),
        })),
      },
      ot_requests_pending: {
        count: otPendingRows.length,
        employees: new Set(otPendingRows.map((r) => r.employee_id)).size,
        minutes: otMinutes,
      },
    };
  };

  /* ----------------------------------------------------------- the panels */

  /**
   * A. Attendance Overview - the mutually exclusive headcount breakdown.
   *
   * The slices partition the population, so they always sum to the total;
   * `reconciles` says so explicitly rather than leaving a reader to add up the
   * chart.
   *
   * NO REST-DAY SLICE AND NO REST-DAY COUNT. An earlier version reported
   * `rest_day_no_punch` beside the slices and diverted such days out of
   * Absent. Both are gone: v2 has no weekly-off concept, and a dashboard-only
   * rest-day rule WAS one - it made this screen disagree with the employee's
   * own attendance for the same date, which is worse than the ambiguity it was
   * trying to be careful about. The engine's answer is used, subject to the
   * open-day and delivery safeguards that apply to every other date.
   *
   * `unconfirmed_absence` is a different thing entirely, and IS reported: the
   * number of no-punch days on a closed day whose LOCATION has no delivery
   * evidence. Those sit in Unresolved rather than Absent, and naming the count
   * is what stops that looking like an unexplained gap.
   */
  const buildOverviewPanel = (rows) => {
    const counts = new Map(PRESENCE_SLICE_ORDER.map((s) => [s, 0]));
    rows.forEach((r) => counts.set(r.slice, (counts.get(r.slice) || 0) + 1));
    const slices = PRESENCE_SLICE_ORDER.map((slice) => ({
      slice,
      label: PRESENCE_SLICE_LABEL[slice],
      count: counts.get(slice) || 0,
    }));
    const sum = slices.reduce((a, s) => a + s.count, 0);
    return {
      slices,
      total: rows.length,
      reconciles: sum === rows.length,
      unconfirmed_absence: rows.filter(
        (r) =>
          r.punch_count === 0 &&
          r.day_closed &&
          r.coverage !== COVERAGE.COMPLETE &&
          r.slice === PRESENCE_SLICE.UNRESOLVED
      ).length,
      note:
        "Slices are mutually exclusive: every applicable employee appears in exactly one. " +
        "Need Action, late/early and OT are counted separately because they can also be true " +
        "of an employee who is Checked In.",
    };
  };

  /**
   * B. Outlet / Warehouse attendance. Real location headcounts, each with its
   * own denominator attached so the percentage can always be read back to the
   * counts it came from.
   */
  const buildLocationPanel = (rows) => {
    const keys = [...new Set(rows.map((r) => (r.store_id === null ? "none" : r.store_id)))];
    const tally = tallyBy(rows, (r) => (r.store_id === null ? "none" : r.store_id), keys);
    const names = new Map(
      rows.map((r) => [String(r.store_id === null ? "none" : r.store_id), r.outlet_name])
    );
    return [...tally.entries()]
      .map(([key, counters]) => ({
        store_id: key === "none" ? null : Number(key),
        outlet_name: key === "none" ? "No outlet on record" : names.get(key) || `Outlet ${key}`,
        total: counters.total,
        checked_in: counters[PRESENCE_SLICE.CHECKED_IN],
        not_yet_checked_in: counters[PRESENCE_SLICE.NOT_YET_CHECKED_IN],
        shift_not_started: counters[PRESENCE_SLICE.SHIFT_NOT_STARTED],
        absent: counters[PRESENCE_SLICE.ABSENT],
        unresolved: counters[PRESENCE_SLICE.UNRESOLVED],
        need_action: counters.need_action,
        check_in_rate: rate(counters[PRESENCE_SLICE.CHECKED_IN], counters.total),
      }))
      .sort((a, b) => b.total - a.total || String(a.outlet_name).localeCompare(String(b.outlet_name)));
  };

  /**
   * C. Shift-wise attendance, over the EFFECTIVE configured shifts.
   *
   * Employees whose shift could not be resolved for the date are NOT dropped -
   * they are grouped under an explicit setup-gap row, because silently losing
   * them would hide the configuration fault and make the columns stop adding
   * up to the population.
   */
  const buildShiftPanel = (rows) => {
    // A ROW IS A SETUP GAP WHENEVER THE SHIFT DID NOT RESOLVE, which is not
    // the same as having no shift id. `NO_SCHEDULE_ROW` resolves an
    // ASSIGNMENT - so the employee does have a `work_shift_id` - and then
    // fails to find that shift's row for the weekday. Grouping those people
    // under the shift's own name would list them beside colleagues whose
    // roster is fine and hide the fault completely, which is exactly the
    // silent loss this panel is supposed to prevent. So they get their own
    // labelled row, and the label names the shift AND the fault.
    const isGap = (r) =>
      r.shift_resolution_status === RESOLUTION_STATUS.NO_SHIFT_FOR_DATE ||
      r.shift_resolution_status === RESOLUTION_STATUS.NO_SCHEDULE_ROW;
    const keyOf = (r) =>
      isGap(r) ? `gap:${r.shift_resolution_status}:${r.work_shift_id === null ? "none" : r.work_shift_id}` : `shift:${r.work_shift_id}`;
    const keys = [...new Set(rows.map(keyOf))];
    const tally = tallyBy(rows, keyOf, keys);
    const labelOf = (r) => {
      const name = r.shift_code || r.shift_name || (r.work_shift_id ? `Shift ${r.work_shift_id}` : null);
      if (!isGap(r)) return name || "Shift (unnamed)";
      if (r.shift_resolution_status === RESOLUTION_STATUS.NO_SHIFT_FOR_DATE) {
        return "No shift assigned";
      }
      return name ? `${name} — no schedule row` : "Shift setup issue";
    };
    const labels = new Map(rows.map((r) => [String(keyOf(r)), labelOf(r)]));
    const shiftIds = new Map(
      rows.map((r) => [String(keyOf(r)), r.work_shift_id === null ? null : Number(r.work_shift_id)])
    );
    const gaps = new Map(rows.map((r) => [String(keyOf(r)), isGap(r)]));
    return [...tally.entries()]
      .map(([key, counters]) => ({
        work_shift_id: shiftIds.get(key) === undefined ? null : shiftIds.get(key),
        shift_label: labels.get(key) || String(key),
        setup_gap: gaps.get(key) === true,
        expected: counters.total,
        checked_in: counters[PRESENCE_SLICE.CHECKED_IN],
        not_yet_checked_in: counters[PRESENCE_SLICE.NOT_YET_CHECKED_IN],
        shift_not_started: counters[PRESENCE_SLICE.SHIFT_NOT_STARTED],
        absent: counters[PRESENCE_SLICE.ABSENT],
        unresolved: counters[PRESENCE_SLICE.UNRESOLVED],
        need_action: counters.need_action,
        check_in_rate: rate(counters[PRESENCE_SLICE.CHECKED_IN], counters.total),
      }))
      .sort((a, b) => {
        if (a.setup_gap !== b.setup_gap) return a.setup_gap ? 1 : -1;
        return String(a.shift_label).localeCompare(String(b.shift_label));
      });
  };

  /** E. Attention Required: the four canonical issues, worst first. */
  const buildAttentionPanel = (rows) =>
    NEED_ACTION_ISSUE_KEYS.map((key) => ({
      key,
      label: ISSUE_LABEL[key],
      count: new Set(rows.filter((r) => r.issue_key === key).map((r) => r.employee_id)).size,
    })).sort((a, b) => b.count - a.count);

  /* ---------------------------------------------------------- the reads */

  /**
   * The filter selectors' options: the REAL master data, never a sample list.
   *
   * The shift options are Shift Management's own active rows, so whatever is
   * configured there (9-9, 10-10, 2-10, anything added later) is what the
   * selector offers and this screen cannot introduce a shift of its own.
   */
  const getFilters = async ({ store_ids = null } = {}) => {
    // An empty authorized scope offers no outlets, rather than every outlet.
    if (Array.isArray(store_ids) && store_ids.length === 0) {
      return { outlets: [], designations: [], shifts: [], today: istNowParts().date };
    }
    const [outlets, designations, shifts] = await Promise.all([
      attendanceDashboardRepo.listOutlets({ store_ids }),
      attendanceDashboardRepo.listDesignations(),
      attendanceDashboardRepo.listActiveWorkShifts(),
    ]);
    return {
      outlets: (outlets || []).map((o) => ({
        store_id: Number(o.outlet_id),
        outlet_name: o.outlet_name || o.outlet_nickname || `Outlet ${o.outlet_id}`,
      })),
      designations: (designations || []).map((d) => ({
        designation_id: Number(d.designation_id),
        designation_name: d.designation_name,
      })),
      shifts: (shifts || []).map((s) => ({
        work_shift_id: Number(s.work_shift_id),
        shift_code: s.shift_code,
        shift_name: s.shift_name,
      })),
      today: istNowParts().date,
    };
  };

  /**
   * THE OVERVIEW: the six cards and the panels that do not need their own
   * date range, for one attendance date and one set of filters.
   *
   * `fetched_at` is when this response was built and is labelled as such. It
   * is NOT a device sync time and never presented as one - device freshness
   * comes from `getDeviceHealth`, out of the terminals' own `last_seen_at`.
   */
  const getOverview = async ({
    attendance_date,
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    now = Date.now(),
  }) => {
    const { date, rows, coverage, coverage_available } = await buildPopulation({
      attendance_date,
      store_ids,
      designation_id,
      work_shift_id,
      search,
      now,
    });

    const nowParts = istNowParts(now);
    // The date is a completed day only when EVERY applicable employee's own
    // shift has closed it. One night shift still running means the day is
    // still open, and its rate is provisional.
    const dayClosed = rows.length > 0 && rows.every((r) => r.day_closed);

    return {
      attendance_date: date,
      is_open_day: !dayClosed,
      day_state: dayClosed ? "CLOSED" : "OPEN",
      day_state_note: dayClosed
        ? "This attendance day has closed under every applicable shift's cutoff; the figures are settled."
        : "This attendance day is still open. Counts are observed so far, not finalized attendance, " +
          "and confirmed absence and missing punches are withheld until it closes.",
      fetched_at: `${nowParts.date} ${String(Math.floor(nowParts.minutes / 60)).padStart(2, "0")}:${String(
        nowParts.minutes % 60
      ).padStart(2, "0")}`,
      // DELIVERY COVERAGE for this date, per outlet in scope. Reported beside
      // the counts because it is what decides whether a no-punch day is an
      // absence or a gap in the feed, and a reader is entitled to see which.
      coverage: [...coverage.entries()].map(([key, verdict]) => ({
        store_id: key === "none" ? null : Number(key),
        coverage: verdict,
        label: COVERAGE_LABEL[verdict],
      })),
      coverage_available,
      delivery_confirmed:
        rows.length > 0 && [...coverage.values()].every((v) => v === COVERAGE.COMPLETE),
      cards: buildCards(rows),
      overview: buildOverviewPanel(rows),
      by_location: buildLocationPanel(rows),
      by_shift: buildShiftPanel(rows),
      attention: buildAttentionPanel(rows),
      metric_definitions: {
        check_in_rate: CHECK_IN_RATE_DEFINITION,
        applicable:
          "Employed on the attendance date: joined on or before it and not resigned before it. " +
          "new_employee.status is deliberately not read - it is hand-maintained and stale for most leavers.",
        checked_in:
          "At least one valid effective punch dated to the attendance day, after voided and " +
          "within-10-minute duplicate punches are excluded and approved regularized punches are " +
          "included. Not 'currently inside', and not a finalized payable Present Day.",
        absent:
          "The engine's ABSENT status, reported only once the attendance day has closed under that " +
          "employee's own shift cutoff.",
        need_action:
          "Missing Punch, Regularization Pending, No Shift Assigned or Shift Setup Issue. " +
          "A missing punch is only reported once the day has closed. A pending OT request alone " +
          "never puts a day here.",
        delivery_coverage:
          "Whether the punches for this attendance day have actually reached us, decided per " +
          "location: COMPLETE when every terminal mapped to that outlet has been in contact with " +
          "the receiver at or after the day's own close instant; INCOMPLETE when a historical " +
          "pull covering the date is still running; UNKNOWN otherwise. A closed day is not a " +
          "complete one, so confirmed absence requires COMPLETE - without it a no-punch day is " +
          "reported as Unresolved / Data Pending. There is no freshness threshold in this rule.",
      },
    };
  };

  /**
   * THE DRILLDOWN behind every card, slice, issue and panel row - the same
   * population, the same filters, narrowed to one bucket and PAGINATED.
   *
   * THE BUCKET IS THE EXACT GROUP THAT WAS CLICKED. An earlier version sent a
   * shift-setup row to the whole `UNRESOLVED` population, which was wrong in
   * both directions: it listed people whose day was unresolved for entirely
   * different reasons, and it MISSED the employee this panel most needs to
   * show - somebody who punched normally but whose shift has no schedule row.
   * That person is Checked In (they turned up) and Need Action (their roster
   * is broken) at the same time, so their presence slice is CHECKED_IN and a
   * slice-based drilldown could never find them. Issue buckets therefore
   * select on `issue_key`, which is true of them, and combine with the
   * ordinary `work_shift_id` filter to name the exact row.
   *
   * `store_unassigned` is the same idea for the location panel's
   * "no outlet on record" row: an employee with no `store_id` cannot be
   * selected by a store filter, and omitting the filter returns everybody. It
   * is an explicit predicate rather than an absence of one.
   */
  const getDrilldown = async ({
    attendance_date,
    bucket,
    store_ids = null,
    store_unassigned = false,
    designation_id = null,
    work_shift_id = null,
    search = null,
    limit = 50,
    offset = 0,
    now = Date.now(),
  }) => {
    const pick = (() => {
      switch (bucket) {
        case "TOTAL":
          return () => true;
        case "CHECKED_IN":
          return (r) => r.punch_count > 0;
        case "NOT_YET_CHECKED_IN":
          return (r) => r.slice === PRESENCE_SLICE.NOT_YET_CHECKED_IN;
        case "SHIFT_NOT_STARTED":
          return (r) => r.slice === PRESENCE_SLICE.SHIFT_NOT_STARTED;
        case "ABSENT":
          return (r) => r.slice === PRESENCE_SLICE.ABSENT;
        case "UNRESOLVED":
          return (r) => r.slice === PRESENCE_SLICE.UNRESOLVED;
        case "UNCONFIRMED_ABSENCE":
          // The people a completeness gap is holding: no punch, day over, and
          // their location's delivery unconfirmed.
          return (r) =>
            r.punch_count === 0 && r.day_closed && r.coverage !== COVERAGE.COMPLETE;
        case "NEED_ACTION":
          return (r) => r.need_action;
        case "OT_PENDING":
          return (r) => r.ot_request_pending;
        case ISSUE_KEY.MISSING_PUNCH:
        case ISSUE_KEY.REGULARIZATION_PENDING:
        case ISSUE_KEY.NO_SHIFT:
        case ISSUE_KEY.SHIFT_SETUP:
          return (r) => r.issue_key === bucket;
        default:
          throw validationError(`Unknown drilldown bucket ${bucket}`);
      }
    })();

    const { date, rows } = await buildPopulation({
      attendance_date,
      store_ids,
      designation_id,
      work_shift_id,
      search,
      now,
    });

    const matched = rows
      .filter(pick)
      // The location panel's unassigned row, as an explicit selection.
      .filter((r) => (store_unassigned ? r.store_id === null : true))
      .sort((a, b) =>
        String(a.outlet_name || "").localeCompare(String(b.outlet_name || "")) ||
        String(a.employee_name || "").localeCompare(String(b.employee_name || ""))
      );

    const size = Math.max(1, Math.min(MAX_DRILLDOWN_LIMIT, Math.trunc(Number(limit) || 50)));
    const start = Math.max(0, Math.trunc(Number(offset) || 0));

    return {
      attendance_date: date,
      bucket,
      total: matched.length,
      limit: size,
      offset: start,
      // Echoed back so the screen can prove the list it is showing is the one
      // it asked for, and so pagination carries the same group.
      applied_filters: {
        store_ids: store_ids === null ? null : [...store_ids],
        store_unassigned: !!store_unassigned,
        designation_id: designation_id === null ? null : Number(designation_id),
        work_shift_id: work_shift_id === null ? null : Number(work_shift_id),
        search: search || null,
      },
      employees: matched.slice(start, start + size),
    };
  };

  /**
   * D. THE TREND: completed attendance days only, each with ITS OWN
   * applicable population.
   *
   * THE POPULATION IS RESOLVED PER DATE, which is the defect this replaces.
   * The first version took the employees applicable on the SELECTED date and
   * reused that list for every earlier day, which was wrong twice over: a
   * mid-window joiner was counted as applicable on days before they worked
   * here - inflating the denominator and manufacturing absences against
   * somebody who had not started - and a mid-window leaver vanished from the
   * days they actually worked. Now the candidate set is everybody whose
   * employment overlaps the window, and applicability is decided for each date
   * with the SAME rule the single-date query applies in SQL. That is what
   * makes a date shared with the overview come out identically.
   *
   * STILL ONE BATCH. The per-date decision is arithmetic over rows already in
   * memory; there is no query per employee and none per date.
   *
   * THE WINDOW ENDS AT THE LAST DAY THAT HAS ACTUALLY CLOSED, not at the
   * selected date. An in-progress day's check-in rate is not comparable with a
   * finished day's - half a night shift has not punched yet - so plotting it
   * beside them would read as a collapse in attendance that never happened.
   *
   * A DAY WITH NO POPULATION, OR WITH NO DELIVERY EVIDENCE, IS UNAVAILABLE -
   * never 0%. Nobody employed is not an attendance failure, and a day whose
   * punches may still be in transit yields a rate that is only a LOWER BOUND;
   * presenting either as a settled percentage would overstate absence.
   */
  const getTrend = async ({
    attendance_date,
    days = DEFAULT_TREND_DAYS,
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    now = Date.now(),
  }) => {
    const selected = toDateOnly(attendance_date);
    if (selected === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    const window = Math.max(1, Math.min(MAX_TREND_DAYS, Math.trunc(Number(days) || DEFAULT_TREND_DAYS)));

    const emptyResult = (reason) => ({
      from_date: null,
      to_date: null,
      requested_days: window,
      days: [],
      available: false,
      reason,
      definition: CHECK_IN_RATE_DEFINITION,
    });

    // An empty authorized scope reads nothing, exactly as the overview does.
    if (Array.isArray(store_ids) && store_ids.length === 0) return emptyResult("NO_POPULATION");

    const probeFrom = addDays(selected, -(window + 1));

    // The candidate set for the WHOLE window, with the dated facts needed to
    // decide each day. `search` is honoured here as an ordinary filter - the
    // first version dropped it, so the chart quietly described a different
    // population from the cards above it.
    const candidates = await attendanceDashboardRepo.listApplicableEmployeesForRange({
      from_date: probeFrom,
      to_date: selected,
      store_ids,
      designation_id,
      search,
    });
    if (!candidates || candidates.length === 0) return emptyResult("NO_POPULATION");
    if (candidates.length > MAX_POPULATION) {
      throw validationError(
        `${candidates.length} employees match; narrow the filters to at most ${MAX_POPULATION}`
      );
    }

    const batch = await loadBatch({ employees: candidates, from: probeFrom, to: selected });
    const dates = dateRange(probeFrom, selected);

    /**
     * Applicability for ONE employee on ONE date - the same two dated facts,
     * in the same direction, as `listApplicableEmployees` applies in SQL:
     * joined on or before the date, and not resigned before it. An absent or
     * unreadable joining date leaves the start unbounded, exactly as the SQL
     * `IS NULL` branch does, because most production rows have no readable one.
     */
    const applicableOn = (employee, date) => {
      const joined = toDateOnly(employee.joined_on);
      if (joined !== null && joined > date) return false;
      const resigned = toDateOnly(employee.resignation_date);
      if (resigned !== null && resigned < date) return false;
      return true;
    };

    // Coverage inputs for the whole window, read once.
    const coverageInputs = await loadRangeCoverageInputs({
      from: probeFrom,
      to: selected,
      store_ids,
    });

    const perDate = new Map(dates.map((d) => [d, []]));
    candidates.forEach((employee) => {
      const days_ = computeDaysForEmployee({ employee, dates, batch });
      days_.forEach((day, i) => {
        const date = dates[i];
        if (!applicableOn(employee, date)) return;
        if (work_shift_id !== null && Number(day.work_shift_id) !== Number(work_shift_id)) return;
        perDate.get(date).push({
          employee_id: Number(employee.employee_id),
          store_id: employee.store_id === null || employee.store_id === undefined
            ? null
            : Number(employee.store_id),
          punch_count: Number(day.punch_count) || 0,
          status: day.status,
          snapshot: day.shift_snapshot || null,
          closed: isDayClosed({ attendance_date: date, snapshot: day.shift_snapshot || null, now }),
        });
      });
    });

    // Completed days only, then the most recent `window` of them, oldest first.
    const completed = dates
      .filter((date) => {
        const rows = perDate.get(date) || [];
        return rows.length > 0 && rows.every((r) => r.closed);
      })
      .slice(-window);

    const series = completed.map((date) => {
      const rows = perDate.get(date) || [];
      const coverage = coverageForDate({ date, rows, inputs: coverageInputs });

      const applicable = new Set(rows.map((r) => r.employee_id)).size;
      const checkedIn = new Set(rows.filter((r) => r.punch_count > 0).map((r) => r.employee_id)).size;

      // Absence is only counted where delivery for that employee's location is
      // confirmed - the same rule the overview applies, so a date shared with
      // it reconciles.
      const absent = rows.filter(
        (r) =>
          r.punch_count === 0 &&
          r.status === CALC_STATUS.ABSENT &&
          coverage.byOutlet.get(outletKeyOf(r.store_id)) === COVERAGE.COMPLETE
      ).length;

      const fullyCovered = coverage.allComplete;
      return {
        attendance_date: date,
        applicable,
        checked_in: checkedIn,
        absent,
        delivery_confirmed: fullyCovered,
        // A rate with unconfirmed delivery is a LOWER BOUND, not a
        // measurement, so it is marked unavailable rather than plotted.
        check_in_rate: fullyCovered
          ? rate(checkedIn, applicable)
          : { numerator: checkedIn, denominator: applicable, percent: null, available: false },
        unavailable_reason: fullyCovered
          ? null
          : "Punch delivery for this day is not confirmed for every location, so the rate would be a lower bound",
      };
    });

    const plotted = series.filter((d) => d.check_in_rate.available).length;
    return {
      from_date: series.length ? series[0].attendance_date : null,
      to_date: series.length ? series[series.length - 1].attendance_date : null,
      requested_days: window,
      days: series,
      available: plotted > 0,
      reason:
        series.length === 0
          ? "NO_COMPLETED_DAYS"
          : plotted === 0
          ? "NO_CONFIRMED_DELIVERY"
          : series.length < window
          ? "PARTIAL_HISTORY"
          : null,
      definition: CHECK_IN_RATE_DEFINITION,
      note:
        "Completed attendance days only, each with its own applicable population. The selected " +
        "day is excluded while it is still open. A day whose punch delivery is not confirmed is " +
        "reported without a rate rather than as a lower bound.",
      limitations:
        "Employment is read from the joining and resignation dates, which is the same source the " +
        "rest of attendance uses. A resign-then-rejoin GAP is not modelled by that source, so a " +
        "rejoined employee counts as applicable across the gap.",
    };
  };

  /**
   * F. Recent punches and device sync, FOR THE SELECTED ATTENDANCE DATE and
   * the selected filters - EVIDENCE, never a verdict.
   *
   * IT IS THE SAME DAY THE REST OF THE SCREEN IS SHOWING. The first version
   * took the latest punches received company-wide, ignoring the chosen date,
   * shift, designation and employee search - so the panel could be describing
   * this morning while every card above it described last Tuesday. Now the
   * punches are the ones the ENGINE dated to the selected attendance day for
   * the employees in scope, which means membership follows the shift's own
   * cutoff and an overnight 00:30 punch appears under the shift date it
   * belongs to rather than the calendar date it landed on.
   *
   * DIRECTION IS NOT GUESSED. The engine pairs punches POSITIONALLY over a
   * whole attendance day and deliberately ignores the terminal's own flag,
   * which the Biomax schema documents as "NOT a direction flag". This panel
   * shows the tail of a day rather than a whole day per employee, so it
   * reports `direction: "PUNCH"` and links to the employee's own day, which
   * does hold the whole day and does show IN and OUT.
   *
   * AN EXCLUDED PUNCH IS LABELLED AND COUNTED NOWHERE. Voided and
   * duplicate-suppressed punches are shown for diagnosis, flagged `excluded`;
   * they take no part in any check-in count on this dashboard.
   *
   * DEVICE HEALTH IS OBSERVED NOW, AND SAYS SO. `last_seen_at` is the
   * terminal's current state, not a historical fact about the selected date,
   * so it is returned under `observed_at` with that stated plainly - today's
   * contact is not evidence that a punch from three weeks ago was delivered.
   * The per-date delivery verdict is the separate `coverage` field, which IS
   * about the selected day.
   */
  const getRecentPunches = async ({
    attendance_date,
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    limit = 25,
    now = Date.now(),
  }) => {
    const nowParts = istNowParts(now);
    const fetchedAt = `${nowParts.date} ${String(Math.floor(nowParts.minutes / 60)).padStart(2, "0")}:${String(
      nowParts.minutes % 60
    ).padStart(2, "0")}`;

    const { date, rows, coverage, coverage_available } = await buildPopulation({
      attendance_date,
      store_ids,
      designation_id,
      work_shift_id,
      search,
      now,
    });

    const size = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 25)));

    // Every punch the engine attributed to this attendance day for the
    // in-scope employees, effective and excluded alike.
    const effectiveIds = new Set();
    const excludedIds = new Set();
    rows.forEach((r) => {
      (r.punch_ids || []).forEach((id) => effectiveIds.add(id));
      (r.excluded_punch_ids || []).forEach((id) => excludedIds.add(id));
    });
    const allIds = [...new Set([...effectiveIds, ...excludedIds])];

    let punches = [];
    let punchesAvailable = true;
    if (allIds.length > 0) {
      try {
        punches = await attendanceDashboardRepo.listPunchesByIds(allIds);
      } catch (err) {
        punchesAvailable = false;
        punches = [];
      }
    }

    // Device health for the locations actually in scope for this view.
    let devices = [];
    let devicesAvailable = true;
    try {
      devices = await attendanceDashboardRepo.listDeviceSyncHealth({ store_ids });
    } catch (err) {
      devicesAvailable = false;
      devices = [];
    }

    const ageMinutes = (value) => {
      if (!value) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(value));
      if (!m) return null;
      const then =
        Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 60000 +
        Number(m[4]) * 60 +
        Number(m[5]);
      const nowAbs =
        Date.UTC(
          Number(nowParts.date.slice(0, 4)),
          Number(nowParts.date.slice(5, 7)) - 1,
          Number(nowParts.date.slice(8, 10))
        ) /
          60000 +
        nowParts.minutes;
      return Math.max(0, Math.round(nowAbs - then));
    };

    return {
      attendance_date: date,
      punches: (punches || [])
        .slice(0, size)
        .map((p) => ({
          punch_id: p.punch_id,
          employee_id: p.employee_id === null ? null : Number(p.employee_id),
          employee_name: p.employee_name || (p.employee_id ? `Employee ${p.employee_id}` : "Unmatched"),
          io_time: p.io_time,
          received_at: p.received_at,
          direction: "PUNCH",
          device_label: p.device_label || p.dev_id || null,
          dev_id: p.dev_id,
          outlet_name: p.punch_outlet_name || null,
          source: p.ingest_source,
          ingest_attendance_date: p.ingest_attendance_date,
          derivation_status: p.derivation_status,
          excluded: excludedIds.has(p.punch_id) || !!p.attendance_punch_void_id,
          excluded_reason: p.attendance_punch_void_id
            ? "Voided - excluded from attendance"
            : excludedIds.has(p.punch_id)
            ? "Excluded - duplicate within ten minutes"
            : null,
        })),
      punches_available: punchesAvailable,
      devices: (devices || []).map((d) => ({
        biomax_device_id: d.biomax_device_id,
        dev_id: d.dev_id,
        label: d.label || d.dev_id,
        outlet_name: d.outlet_name || null,
        last_seen_at: d.last_seen_at || null,
        last_seen_age_minutes: ageMinutes(d.last_seen_at),
        last_punch_at: d.last_punch_at || null,
        last_punch_age_minutes: ageMinutes(d.last_punch_at),
        sync_known: !!d.last_seen_at,
        // The per-date verdict for this terminal's outlet, which is the thing
        // that actually bears on the selected day's absences.
        coverage:
          d.outlet_id === null || d.outlet_id === undefined
            ? COVERAGE.UNKNOWN
            : coverage.get(outletKeyOf(d.outlet_id)) || COVERAGE.UNKNOWN,
      })),
      devices_available: devicesAvailable,
      // Delivery coverage for the SELECTED DATE, per outlet in scope.
      coverage: [...coverage.entries()].map(([key, verdict]) => ({
        store_id: key === "none" ? null : Number(key),
        coverage: verdict,
        label: COVERAGE_LABEL[verdict],
      })),
      coverage_available,
      observed_at: fetchedAt,
      fetched_at: fetchedAt,
      note:
        "Punches are the ones the attendance engine dated to this attendance day, so membership " +
        "follows the shift's cutoff rather than a midnight boundary. Terminal freshness is " +
        "OBSERVED NOW (observed_at) and is not evidence about the selected date; the per-date " +
        "delivery verdict is `coverage`. A quiet terminal is not necessarily offline, and no " +
        "online/offline status is derived from an absence of employee punches.",
    };
  };

  return {
    MAX_TREND_DAYS,
    DEFAULT_TREND_DAYS,
    MAX_POPULATION,
    MAX_DRILLDOWN_LIMIT,
    dateRange,
    buildPopulation,
    buildCards,
    buildOverviewPanel,
    buildLocationPanel,
    buildShiftPanel,
    buildAttentionPanel,
    computeDaysForEmployee,
    loadBatch,
    getFilters,
    getOverview,
    getDrilldown,
    getTrend,
    getRecentPunches,
  };
};
