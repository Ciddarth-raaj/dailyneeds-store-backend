const { addDays, dayDelta } = require("../utils/attendance_engine");
const {
  DELIVERY,
  DELIVERY_DETAIL,
  DELIVERY_LABEL,
  ISSUE_KEY,
  ISSUE_LABEL,
  dashboardIssueKey,
  isDayClosed,
  istNowParts,
  locationDelivery,
} = require("../utils/attendance_dashboard");
const { PUNCH_SOURCE } = require("../utils/attendance_engine");
const {
  GAP,
  GAP_CLASSES,
  GAP_LABEL,
  IN_WITHOUT_LOCATION_CREDIT,
  LOCATION_BASIS,
  MINUTES_PER_DAY,
  RECORDED,
  activeDuty,
  classifyExpected,
  dutyInterval,
  elapsedSince,
  minuteToClock,
  onDutyAt,
  recordedStateAsOf,
  reconcileGap,
  selectSession,
  shiftInterval,
  upcomingTransitions,
} = require("../utils/attendance_staffing");

/**
 * Attendance & Staffing - the operational snapshot.
 *
 * Answers "at this moment, how many should be on duty, how many are recorded
 * IN, and where are the gaps". It is built ON TOP OF the existing dashboard
 * usecase - same batched reads, same attendance engine, same dated shift
 * resolution - and adds only the as-of classification. It stores nothing,
 * recalculates nothing and approves nothing.
 *
 * "CHECKED IN TODAY" AND "RECORDED IN NOW" ARE DIFFERENT METRICS and are named
 * differently everywhere. The historical view keeps the first; this snapshot
 * uses the second. Nothing here reuses a helper that counts "punched at any
 * point" as though it meant "is recorded IN".
 *
 * THE WINDOW IS THREE DATES, each for its own reason:
 *
 *   YESTERDAY  the shift on duty at 01:00 began yesterday, and yesterday's
 *              attendance session can still own this morning's punches.
 *   TODAY      the business date.
 *   TOMORROW   ONLY for the next-hour outlook. At 23:40 the next shift to
 *              begin may be tomorrow's 00:15, and a window that stopped at
 *              midnight would report "no changes" on the one evening when the
 *              answer matters most. Tomorrow is never on duty now and never
 *              contributes to Expected Now.
 *
 * ONE AS-OF PER REQUEST, ONE TIMELINE. The server issues `as_of` once and every
 * comparison in here is made on a single absolute minute axis measured from
 * midnight of the business date. Intervals resolved on yesterday's or
 * tomorrow's own axis are converted onto it before anything is compared -
 * mixing per-date axes is what made the previous next-hour view wrong.
 */
const NEXT_WINDOW_MINUTES = 60;

/** How many rows the snapshot itself carries per list. A PREVIEW, and named so. */
const PREVIEW_LIMIT = 25;

/** Drilldown paging. The client may ask for less; it may not ask for more. */
const DRILLDOWN_MAX_LIMIT = 200;
const DRILLDOWN_DEFAULT_LIMIT = 50;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

const outletKeyOf = (id) => (id === null || id === undefined ? "none" : String(id));
const roleKeyOf = (id) => (id === null || id === undefined ? "none" : String(id));

/** `YYYY-MM-DD HH:MM:SS` on `baseDate`'s minute axis. */
function minuteOnAxis(baseDate, value) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  const delta = dayDelta(baseDate, m[1]);
  if (delta === null) return null;
  return delta * MINUTES_PER_DAY + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * THE DRILLDOWN BUCKETS - the named subsets of one snapshot a screen can page
 * through. Each is a filter over rows the snapshot already classified, so a
 * bucket total can never disagree with the card it was opened from.
 */
const BUCKET = Object.freeze({
  EXPECTED: "EXPECTED",
  RECORDED_IN_EXPECTED_LOCATION: "RECORDED_IN_EXPECTED_LOCATION",
  GAP: "GAP",
  NO_CHECK_IN: "NO_CHECK_IN",
  RECORDED_OUT: "RECORDED_OUT",
  IN_ELSEWHERE: "IN_ELSEWHERE",
  IN_LOCATION_UNKNOWN: "IN_LOCATION_UNKNOWN",
  EXPECTED_LOCATION_UNKNOWN: "EXPECTED_LOCATION_UNKNOWN",
  INDETERMINATE: "INDETERMINATE",
  RECORDED_IN_LOCATION_UNVERIFIED: "RECORDED_IN_LOCATION_UNVERIFIED",
  UNKNOWN_EXPECTATION: "UNKNOWN_EXPECTATION",
  EARLY: "EARLY",
  NO_ACTIVE_SHIFT: "NO_ACTIVE_SHIFT",
  NEEDS_ATTENTION: "NEEDS_ATTENTION",
});

const BUCKET_LABEL = Object.freeze({
  EXPECTED: "Expected now",
  RECORDED_IN_EXPECTED_LOCATION: "Recorded IN at the expected location",
  GAP: "Not recorded IN against schedule",
  NO_CHECK_IN: GAP_LABEL.NO_CHECK_IN,
  RECORDED_OUT: GAP_LABEL.RECORDED_OUT,
  IN_ELSEWHERE: GAP_LABEL.IN_ELSEWHERE,
  IN_LOCATION_UNKNOWN: GAP_LABEL.IN_LOCATION_UNKNOWN,
  EXPECTED_LOCATION_UNKNOWN: GAP_LABEL.EXPECTED_LOCATION_UNKNOWN,
  INDETERMINATE: GAP_LABEL.INDETERMINATE,
  RECORDED_IN_LOCATION_UNVERIFIED: "Recorded IN, location not verified",
  UNKNOWN_EXPECTATION: "Expected coverage unknown - shift setup required",
  EARLY: "Recorded IN before the shift starts",
  NO_ACTIVE_SHIFT: "Recorded IN with no active shift",
  NEEDS_ATTENTION: "Needs attention now",
});

const BUCKETS = Object.freeze(Object.keys(BUCKET));

/**
 * WHAT NEEDS SOMEBODY NOW - the reasons, in the order they are worked.
 *
 * Every one is an EXISTING state read from existing data. None is a new
 * workflow, none is approved or cleared here, and the dashboard is not a queue:
 * each item points at the screen that already owns the action.
 */
const ATTENTION = Object.freeze({
  SHIFT_SETUP: "SHIFT_SETUP",
  NO_CHECK_IN: "NO_CHECK_IN",
  IN_ELSEWHERE: "IN_ELSEWHERE",
  IN_LOCATION_UNKNOWN: "IN_LOCATION_UNKNOWN",
  EXPECTED_LOCATION_UNKNOWN: "EXPECTED_LOCATION_UNKNOWN",
  INDETERMINATE: "INDETERMINATE",
  REGULARIZATION_PENDING: "REGULARIZATION_PENDING",
  OT_PENDING: "OT_PENDING",
  MISSING_PUNCH: "MISSING_PUNCH",
});

const ATTENTION_LABEL = Object.freeze({
  SHIFT_SETUP: "Shift setup required",
  NO_CHECK_IN: "No check-in after shift start",
  IN_ELSEWHERE: "Recorded IN at another location",
  IN_LOCATION_UNKNOWN: "Recorded IN, punch location not established",
  EXPECTED_LOCATION_UNKNOWN: "Expected location not on record",
  INDETERMINATE: "Punch state needs verification",
  REGULARIZATION_PENDING: ISSUE_LABEL.REGULARIZATION_PENDING,
  OT_PENDING: "OT Approval Pending",
  MISSING_PUNCH: ISSUE_LABEL.MISSING_PUNCH,
});

/**
 * Where the action actually lives. The dashboard only links; the target screen
 * keeps its own permission, and a user without it simply cannot follow the
 * link - the dashboard neither grants nor checks that access on its behalf.
 */
const ATTENTION_TARGET = Object.freeze({
  SHIFT_SETUP: "SHIFT_ASSIGNMENT",
  NO_CHECK_IN: "ATTENDANCE_DETAIL",
  IN_ELSEWHERE: "ATTENDANCE_DETAIL",
  IN_LOCATION_UNKNOWN: "ATTENDANCE_DETAIL",
  EXPECTED_LOCATION_UNKNOWN: "ATTENDANCE_DETAIL",
  INDETERMINATE: "ATTENDANCE_DETAIL",
  REGULARIZATION_PENDING: "APPROVAL_QUEUE",
  OT_PENDING: "OT_APPROVAL_QUEUE",
  MISSING_PUNCH: "ATTENDANCE_DETAIL",
});

/** Worked in this order. Operational now first, then waiting approvals. */
const ATTENTION_ORDER = Object.freeze([
  ATTENTION.SHIFT_SETUP,
  ATTENTION.NO_CHECK_IN,
  ATTENTION.IN_ELSEWHERE,
  ATTENTION.IN_LOCATION_UNKNOWN,
  ATTENTION.EXPECTED_LOCATION_UNKNOWN,
  ATTENTION.INDETERMINATE,
  ATTENTION.REGULARIZATION_PENDING,
  ATTENTION.OT_PENDING,
  ATTENTION.MISSING_PUNCH,
]);

module.exports = (attendanceDashboardRepo, dashboardUsecase) => {
  /**
   * Everything the snapshot needs for the business date, the one before it and
   * the one after it.
   *
   * THE CANDIDATE POPULATION IS THE RANGE, NOT THE BUSINESS DATE, and the
   * defect this replaces was exactly that confusion. Employees were loaded with
   * `listApplicableEmployees({ attendance_date: businessDate })` and only then
   * asked about yesterday's and tomorrow's shifts - so an employee whose
   * relevant shift belongs to a DIFFERENT attendance date could never appear at
   * all, however valid that shift was:
   *
   *   AT 01:00 ON THE 13th, somebody whose employment ended on the 12th and who
   *   is two hours into a 22:00-06:00 shift DATED the 12th vanished from
   *   Expected Now - their duty interval was live, and they were not in the
   *   population to be asked about.
   *
   *   AT 23:40 ON THE 13th, somebody joining on the 14th whose first shift
   *   begins at 00:15 was never considered for the next-hour outlook, though
   *   that start is thirty-five minutes away.
   *
   * So the candidates are everyone whose employment OVERLAPS previousDate ->
   * nextDate, and applicability is then decided PER DATE with
   * `dashboardUsecase.applicableOn` - the same rule the corrected trend uses,
   * shared rather than restated. Being in the range does not put anybody in a
   * date's shift; only being applicable on that date does.
   *
   * THE SCOPE IS UNCHANGED AND STILL SERVER-SIDE. The range query applies the
   * same `locationPredicate` on the same column as the single-date one, so a
   * yesterday or tomorrow shift cannot surface an employee from an outlet the
   * caller is not authorized for - the widening that would matter here is a
   * location one, and neither query can do it.
   */
  const loadSnapshotContext = async ({ businessDate, filters }) => {
    const previousDate = addDays(businessDate, -1);
    const nextDate = addDays(businessDate, 1);

    const employees = await attendanceDashboardRepo.listApplicableEmployeesForRange({
      from_date: previousDate,
      to_date: nextDate,
      store_ids: filters.store_ids,
      designation_id: filters.designation_id,
      search: filters.search,
    });
    if (!employees || employees.length === 0) {
      return {
        employees: [],
        byEmployee: new Map(),
        punchLocations: new Map(),
        locations_available: true,
        previousDate,
        nextDate,
      };
    }

    const batch = await dashboardUsecase.loadBatch({
      employees,
      from: previousDate,
      to: nextDate,
    });

    const dates = [previousDate, businessDate, nextDate];
    const byEmployee = new Map();
    employees.forEach((employee) => {
      const computed = dashboardUsecase.computeDaysForEmployee({ employee, dates, batch });
      const days = {};
      dates.forEach((date, i) => {
        days[date] = computed[i];
      });
      byEmployee.set(String(employee.employee_id), { employee, days });
    });

    // Where each punch happened, so a cross-location arrival can be told from
    // cover. A terminal with no outlet mapping yields no entry, and a lookup
    // that FAILS yields no entries at all - both are "location not known",
    // which is now a class of its own rather than silent coverage.
    const punchIds = [];
    byEmployee.forEach(({ days }) => {
      Object.values(days).forEach((day) => {
        (day.effective_punches || []).forEach((p) => {
          if (p.punch_id !== null && p.punch_id !== undefined) punchIds.push(p.punch_id);
        });
      });
    });

    const punchLocations = new Map();
    let locationsAvailable = true;
    if (punchIds.length > 0) {
      if (!attendanceDashboardRepo.listPunchesByIds) {
        locationsAvailable = false;
      } else {
        try {
          const rows = await attendanceDashboardRepo.listPunchesByIds([...new Set(punchIds)]);
          (rows || []).forEach((r) => {
            punchLocations.set(String(r.punch_id), {
              outlet_id:
                r.punch_outlet_id === null || r.punch_outlet_id === undefined
                  ? null
                  : Number(r.punch_outlet_id),
              outlet_name: r.punch_outlet_name || null,
              device_label: r.device_label || r.dev_id || null,
            });
          });
        } catch (err) {
          // THE LOOKUP FAILED, so NO punch location is known. Every recorded IN
          // becomes "location not established" - it must not become coverage,
          // which is exactly what the previous version did by swallowing this.
          locationsAvailable = false;
        }
      }
    }

    return {
      employees,
      byEmployee,
      punchLocations,
      locations_available: locationsAvailable,
      previousDate,
      nextDate,
    };
  };

  /** Delivery assurance per outlet for the business date. Never "confirmed". */
  const resolveDelivery = async ({ businessDate, store_ids, outletKeys }) => {
    let pulls = [];
    let available = true;
    try {
      pulls = attendanceDashboardRepo.listHistoricalPullsForDate
        ? await attendanceDashboardRepo.listHistoricalPullsForDate({
            attendance_date: businessDate,
            store_ids,
          })
        : [];
    } catch (err) {
      available = false;
    }

    const open = new Set();
    const failed = new Set();
    let openUnattributed = false;
    let failedUnattributed = false;
    (pulls || []).forEach((p) => {
      const key = outletKeyOf(p.outlet_id);
      const isFailed = String(p.status) === "FAILED";
      const attributed = p.outlet_id !== null && p.outlet_id !== undefined;
      if (isFailed) {
        if (attributed) failed.add(key);
        else failedUnattributed = true;
      } else {
        if (attributed) open.add(key);
        else openUnattributed = true;
      }
    });

    const byOutlet = new Map();
    outletKeys.forEach((key) => {
      byOutlet.set(
        key,
        locationDelivery({
          open_pull: openUnattributed || open.has(key),
          failed_pull: failedUnattributed || failed.has(key),
        })
      );
    });
    return { byOutlet, available };
  };

  /* ==================================================== the snapshot core */

  /**
   * THE WHOLE CLASSIFIED SNAPSHOT, unpaged.
   *
   * `getSnapshot` and `getStaffingDrilldown` both go through here, which is
   * what makes a drilldown total equal to the card it came from: they are two
   * views of one computation, not two computations of one question.
   */
  const buildSnapshot = async ({
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    now = Date.now(),
  } = {}) => {
    const nowParts = istNowParts(now);
    const businessDate = nowParts.date;
    const asOf = `${businessDate} ${minuteToClock(nowParts.minutes)}`;

    const base = {
      as_of: asOf,
      business_date: businessDate,
      now_minute: nowParts.minutes,
      rostered: [],
      unknown_expectation: [],
      early: [],
      no_active_shift: [],
      attention: [],
      scheduled_outlook: [],
      delivery: new Map(),
      delivery_available: true,
      locations_available: true,
      reason: null,
    };

    // An empty authorized scope reads nothing.
    if (Array.isArray(store_ids) && store_ids.length === 0) {
      return { ...base, reason: "NO_SCOPE" };
    }

    const filters = { store_ids, designation_id, search };
    const ctx = await loadSnapshotContext({ businessDate, filters });
    if (ctx.employees.length === 0) return { ...base, reason: "NO_POPULATION" };

    const { previousDate, nextDate } = ctx;

    /**
     * THE ONE TIMELINE. Minute 0 is midnight starting the business date, so
     * "now" is simply `nowParts.minutes` and every interval from any of the
     * three dates is converted onto the same axis before comparison.
     */
    const offsetOf = (date) => -dayDelta(date, businessDate) * MINUTES_PER_DAY;
    const nowOn = (date) => nowParts.minutes - offsetOf(date);
    const nowAbsolute = nowParts.minutes;

    const rostered = [];
    const unknownExpectation = [];
    const early = [];
    const noActiveShift = [];
    const scheduledOutlook = [];

    ctx.byEmployee.forEach(({ employee, days }) => {
      const candidateFor = (date) => {
        const day = days[date];
        return {
          attendance_date: date,
          snapshot: day ? day.shift_snapshot : null,
          resolution_status: day ? day.shift_resolution_status : null,
          now_minute: nowOn(date),
          day,
          punches: day
            ? (day.effective_punches || []).map((p) => ({
                punch_id: p.punch_id,
                io_time: p.io_time,
                source: p.source,
                minute: minuteOnAxis(date, p.io_time),
              }))
            : [],
        };
      };

      /**
       * APPLICABILITY IS DECIDED PER DATE, not once for the business date.
       *
       * Being inside the candidate range puts nobody in a date's shift. A
       * yesterday-only employee is applicable to yesterday and not to today; a
       * tomorrow joiner is applicable to tomorrow and not to today. Each date
       * asks separately, through the shared rule.
       */
      const applicable = (date) => dashboardUsecase.applicableOn(employee, date);

      // Only today and yesterday can be ON DUTY now; tomorrow cannot. Each is
      // offered only if the employee was actually employed on that date.
      const dutyCandidates = [businessDate, previousDate]
        .filter(applicable)
        .map(candidateFor);
      const tomorrow = applicable(nextDate) ? candidateFor(nextDate) : null;

      /* ---- B. the schedule outlook: EVERY relevant shift, one axis ---- */
      //
      // Not just the currently-expected population. A shift that starts in
      // twenty minutes is exactly what this view exists to show, and it is not
      // in Expected Now by definition - and neither is a shift that begins just
      // after midnight for somebody who joins tomorrow.
      [...dutyCandidates, tomorrow].filter(Boolean).forEach((candidate) => {
        const interval = dutyInterval(candidate.snapshot);
        if (!interval) return;
        if (
          work_shift_id !== null &&
          candidate.day &&
          Number(candidate.day.work_shift_id) !== Number(work_shift_id)
        ) {
          return;
        }
        scheduledOutlook.push({
          ...employeeRow(employee),
          attendance_date: candidate.attendance_date,
          interval: shiftInterval(interval, offsetOf(candidate.attendance_date)),
          shift_code: candidate.day ? candidate.day.shift_code || candidate.day.shift_name : null,
        });
      });

      // A SETUP FAULT IS ONLY A FAULT ON A DATE THE PERSON IS EMPLOYED. Somebody
      // who left yesterday has no shift today and is not missing one.
      const applicableToday = applicable(businessDate);
      const todaysDay = applicableToday ? days[businessDate] : null;
      const unresolved =
        todaysDay &&
        (todaysDay.shift_resolution_status === "NO_SHIFT_FOR_DATE" ||
          todaysDay.shift_resolution_status === "NO_SCHEDULE_ROW");

      const duty = activeDuty(dutyCandidates);

      /* ------------------------------- not on duty right now ----------- */

      if (!duty) {
        // An unresolvable shift is EXPECTED COVERAGE UNKNOWN, never zero
        // expected. Reported on its own list so a setup fault cannot quietly
        // shrink the headcount everybody is being measured against.
        if (unresolved) {
          unknownExpectation.push({
            ...employeeRow(employee),
            reason:
              todaysDay.shift_resolution_status === "NO_SHIFT_FOR_DATE"
                ? "No shift assigned for this date"
                : "The shift has no schedule row for this weekday",
            resolution_status: todaysDay.shift_resolution_status,
          });
        }

        const observed = observe({
          candidates: dutyCandidates,
          active: null,
          punchLocations: ctx.punchLocations,
          locationsAvailable: ctx.locations_available,
        });
        if (observed.state === RECORDED.IN && !observed.ambiguous) {
          const todaysInterval = dutyInterval(todaysDay ? todaysDay.shift_snapshot : null);
          const startsLater =
            todaysInterval &&
            nowAbsolute < todaysInterval.start + offsetOf(businessDate);
          const row = {
            ...employeeRow(employee),
            recorded_since: minuteToClock(observed.since_minute),
            recorded_minutes: elapsedSince(observed.since_minute, observed.now_minute),
            punch_outlet_id: observed.punch_outlet_id,
            punch_outlet_name: observed.punch_outlet_name,
            location_known: observed.location_known,
            location_basis: observed.location_basis,
            session_date: observed.attendance_date,
            scheduled_start: todaysInterval ? minuteToClock(todaysInterval.start) : null,
          };
          (startsLater ? early : noActiveShift).push(row);
        }
        return;
      }

      if (work_shift_id !== null && Number(duty.day.work_shift_id) !== Number(work_shift_id)) return;

      /* ----------------------------------- on duty: classify ----------- */

      const observed = observe({
        candidates: dutyCandidates,
        active: duty,
        punchLocations: ctx.punchLocations,
        locationsAvailable: ctx.locations_available,
      });

      const expectedOutletId =
        employee.store_id === null || employee.store_id === undefined
          ? null
          : Number(employee.store_id);

      const gapClass = classifyExpected({
        recorded_state: observed.state,
        punch_outlet_id: observed.punch_outlet_id,
        expected_outlet_id: expectedOutletId,
        location_known: observed.location_known,
        location_basis: observed.location_basis,
        ambiguous_session: observed.ambiguous,
      });

      rostered.push({
        ...employeeRow(employee),
        attendance_date: duty.attendance_date,
        work_shift_id: duty.day.work_shift_id === null ? null : Number(duty.day.work_shift_id),
        interval: shiftInterval(duty.interval, offsetOf(duty.attendance_date)),
        shift_code: duty.day.shift_code || duty.day.shift_name || null,
        scheduled_start: minuteToClock(duty.interval.start),
        scheduled_end: minuteToClock(duty.interval.end),
        recorded_state: observed.state,
        recorded_since: minuteToClock(observed.since_minute),
        recorded_minutes: elapsedSince(observed.since_minute, duty.now_minute),
        minutes_since_start: elapsedSince(duty.interval.start, duty.now_minute),
        punch_outlet_id: observed.punch_outlet_id,
        punch_outlet_name: observed.punch_outlet_name,
        location_known: observed.location_known,
        location_basis: observed.location_basis,
        session_date: observed.attendance_date,
        gap_class: gapClass,
        gap_label: GAP_LABEL[gapClass],
      });
    });

    /* ------------------------------- delivery, per outlet in the view ---- */

    const outletKeys = [
      ...new Set([
        ...rostered.map((r) => outletKeyOf(r.store_id)),
        ...unknownExpectation.map((r) => outletKeyOf(r.store_id)),
      ]),
    ];
    const delivery = await resolveDelivery({ businessDate, store_ids, outletKeys });

    /* -------------------------------------- F. needs attention now ------ */

    const attention = await buildAttention({
      byEmployee: ctx.byEmployee,
      rostered,
      unknownExpectation,
      businessDate,
      previousDate,
      now,
    });

    return {
      ...base,
      rostered,
      unknown_expectation: unknownExpectation,
      early,
      no_active_shift: noActiveShift,
      attention,
      scheduled_outlook: scheduledOutlook,
      now_absolute: nowAbsolute,
      delivery: delivery.byOutlet,
      delivery_available: delivery.available,
      locations_available: ctx.locations_available,
      previous_date: previousDate,
      next_date: nextDate,
    };
  };

  /* ======================================================== the snapshot */

  /**
   * THE SNAPSHOT the NOW screen loads.
   *
   * Lists are PREVIEWS and say so: `*_preview` with `preview_limit` and
   * `preview_truncated` beside each total. The defect this replaces sent a
   * silently truncated 200-row array that the screen used as though it were the
   * whole population, so a clickable list could disagree with the headline it
   * was opened from. Full lists come from the drilldown endpoint, which pages.
   */
  const getSnapshot = async (input = {}) => {
    const snap = await buildSnapshot(input);

    const totals = reconcileGap(snap.rostered);
    const coverage = buildCoverage(snap.rostered, snap.delivery);
    const next = buildNextHour(snap);

    const gapRows = orderForDisplay(snap.rostered.filter((r) => r.gap_class !== GAP.COVERED));
    const expectedRows = orderForDisplay(snap.rostered);

    const crossLocation = snap.rostered
      .filter((r) => r.gap_class === GAP.IN_ELSEWHERE)
      .map((r) => ({
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        designation_name: r.designation_name,
        expected_outlet_id: r.store_id,
        expected_outlet_name: r.outlet_name,
        recorded_outlet_id: r.punch_outlet_id,
        recorded_outlet_name: r.punch_outlet_name,
        recorded_at: r.recorded_since,
        verification_needed: true,
      }));

    const unverifiedLocation = snap.rostered.filter((r) =>
      IN_WITHOUT_LOCATION_CREDIT.includes(r.gap_class)
    );

    return {
      as_of: snap.as_of,
      business_date: snap.business_date,

      expected_now: totals.expected,
      recorded_in: totals.recorded_in_at_expected,
      gap: totals.gap,
      reconciles: totals.reconciles,
      gap_by_class: totals.by_class,

      // Recorded IN somewhere, but not creditable to the scheduled outlet.
      // Reported as its own company-wide figure and allocated to no location.
      recorded_in_location_unverified: totals.recorded_in_location_unverified,

      coverage,

      // ---- previews. Totals are authoritative; these rows are a sample. ----
      preview_limit: PREVIEW_LIMIT,
      expected_preview: preview(expectedRows),
      expected_preview_truncated: expectedRows.length > PREVIEW_LIMIT,
      gap_preview: preview(gapRows).map((r) => ({ ...r, explanation: gapExplanation(r) })),
      gap_preview_truncated: gapRows.length > PREVIEW_LIMIT,
      attention_preview: preview(snap.attention),
      attention_total: snap.attention.length,
      attention_preview_truncated: snap.attention.length > PREVIEW_LIMIT,

      next_hour: next,

      additional: {
        early: preview(snap.early),
        early_total: snap.early.length,
        no_active_shift: preview(snap.no_active_shift),
        no_active_shift_total: snap.no_active_shift.length,
        cross_location_arrivals: preview(crossLocation),
        cross_location_total: crossLocation.length,
        location_unverified_total: unverifiedLocation.length,
      },
      unknown_expectation: preview(snap.unknown_expectation),
      unknown_expectation_total: snap.unknown_expectation.length,

      delivery: [...snap.delivery.entries()].map(([key, verdict]) => ({
        store_id: key === "none" ? null : Number(key),
        delivery: verdict,
        label: DELIVERY_LABEL[verdict],
        detail: DELIVERY_DETAIL[verdict],
      })),
      delivery_available: snap.delivery_available,
      punch_locations_available: snap.locations_available,
      reason: snap.reason,

      definitions: {
        expected_now:
          "Applicable employees whose assigned duty interval contains the as-of time: shift start <= now < shift end. The interval is the shift's own in-time to out-time - not normal hours, and not reduced by a break allowance.",
        recorded_in:
          "Expected employees whose latest interpretable punch state as of now is an IN, AT THEIR EXPECTED LOCATION. An IN whose punch location cannot be established is counted separately and credited to no outlet. Recorded IN does NOT mean actively working or available at a counter.",
        gap:
          "Expected Now minus Recorded IN at the expected location, broken into mutually exclusive reasons. It is 'not recorded IN against schedule' - not absence, and not a confirmed shortage.",
        next_hour:
          "Scheduled starts and finishes in the next 60 minutes, from every relevant shift - already running, starting soon, or beginning tomorrow just after midnight. A schedule outlook, not a forecast of who will arrive, and never a judgement about whether the cover is enough.",
        delivery:
          "Whether punches for this date are known to have all arrived. This system has no end-of-transfer acknowledgement, so the answer is never 'confirmed'.",
        preview:
          "The lists on this payload are previews. Full, paged lists come from the staffing drilldown, which recomputes the snapshot and returns its own as_of.",
      },
    };
  };

  /* ======================================================== the drilldown */

  /**
   * ONE BUCKET of the current snapshot, paged.
   *
   * THE SNAPSHOT IS RECOMPUTED HERE, with its own server-issued `as_of` which
   * is returned so the screen can show it. A drilldown opened a minute after
   * the card is a NEW observation and is not promised to match it punch for
   * punch - saying so is honest; pretending otherwise is what a cached list
   * would do.
   */
  const getStaffingDrilldown = async ({
    bucket,
    store_ids = null,
    store_id = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    gap_class = null,
    limit = DRILLDOWN_DEFAULT_LIMIT,
    offset = 0,
    now = Date.now(),
  } = {}) => {
    const key = String(bucket || "").toUpperCase();
    if (!BUCKETS.includes(key)) throw validationError("bucket is not a known staffing bucket");
    if (gap_class !== null && gap_class !== undefined && !GAP_CLASSES.includes(String(gap_class))) {
      throw validationError("gap_class is not a known gap reason");
    }

    const size = Math.max(1, Math.min(DRILLDOWN_MAX_LIMIT, Math.trunc(Number(limit) || DRILLDOWN_DEFAULT_LIMIT)));
    const from = Math.max(0, Math.trunc(Number(offset) || 0));

    // A requested location must be INSIDE the caller's resolved scope. The
    // intersection is done here and not in SQL so an out-of-scope id cannot
    // widen the read; `[]` means nothing is readable and stays that way.
    const scoped = intersectScope(store_ids, store_id);

    const snap = await buildSnapshot({
      store_ids: scoped,
      designation_id,
      work_shift_id,
      search,
      now,
    });

    let rows = rowsForBucket(snap, key);
    if (gap_class) rows = rows.filter((r) => r.gap_class === String(gap_class));

    const total = rows.length;
    const page = rows.slice(from, from + size).map((r) => ({
      ...r,
      explanation: r.gap_class && r.gap_class !== GAP.COVERED ? gapExplanation(r) : r.explanation || null,
    }));

    return {
      as_of: snap.as_of,
      business_date: snap.business_date,
      bucket: key,
      bucket_label: BUCKET_LABEL[key],
      total,
      rows: page,
      limit: size,
      offset: from,
      has_more: from + page.length < total,
      applied_filters: {
        store_ids: scoped,
        store_id: store_id === null || store_id === undefined ? null : Number(store_id),
        designation_id:
          designation_id === null || designation_id === undefined ? null : Number(designation_id),
        work_shift_id:
          work_shift_id === null || work_shift_id === undefined ? null : Number(work_shift_id),
        search: search || null,
        gap_class: gap_class || null,
      },
      punch_locations_available: snap.locations_available,
      reason: snap.reason,
      note:
        "Recomputed as of the time above. A drilldown opened after the card was read is a new observation, not a replay of the earlier one.",
    };
  };

  /** The caller's scope, narrowed by a requested location. Never widened. */
  function intersectScope(store_ids, store_id) {
    const asked = store_id === null || store_id === undefined ? null : Number(store_id);
    if (asked === null) return store_ids;
    if (store_ids === null || store_ids === undefined) return [asked]; // company-wide caller
    if (!Array.isArray(store_ids) || store_ids.length === 0) return [];
    return store_ids.map(Number).includes(asked) ? [asked] : [];
  }

  /** Which classified rows a bucket names. */
  function rowsForBucket(snap, key) {
    const gapRows = snap.rostered.filter((r) => r.gap_class !== GAP.COVERED);
    const ofClass = (cls) => snap.rostered.filter((r) => r.gap_class === cls);

    switch (key) {
      case BUCKET.EXPECTED:
        return orderForDisplay(snap.rostered);
      case BUCKET.RECORDED_IN_EXPECTED_LOCATION:
        return orderForDisplay(ofClass(GAP.COVERED));
      case BUCKET.GAP:
        return orderForDisplay(gapRows);
      case BUCKET.NO_CHECK_IN:
        return orderForDisplay(ofClass(GAP.NO_CHECK_IN));
      case BUCKET.RECORDED_OUT:
        return orderForDisplay(ofClass(GAP.RECORDED_OUT));
      case BUCKET.IN_ELSEWHERE:
        return orderForDisplay(ofClass(GAP.IN_ELSEWHERE));
      case BUCKET.IN_LOCATION_UNKNOWN:
        return orderForDisplay(ofClass(GAP.IN_LOCATION_UNKNOWN));
      case BUCKET.EXPECTED_LOCATION_UNKNOWN:
        return orderForDisplay(ofClass(GAP.EXPECTED_LOCATION_UNKNOWN));
      case BUCKET.INDETERMINATE:
        return orderForDisplay(ofClass(GAP.INDETERMINATE));
      case BUCKET.RECORDED_IN_LOCATION_UNVERIFIED:
        return orderForDisplay(
          snap.rostered.filter((r) => IN_WITHOUT_LOCATION_CREDIT.includes(r.gap_class))
        );
      case BUCKET.UNKNOWN_EXPECTATION:
        return byName(snap.unknown_expectation);
      case BUCKET.EARLY:
        return byName(snap.early);
      case BUCKET.NO_ACTIVE_SHIFT:
        return byName(snap.no_active_shift);
      case BUCKET.NEEDS_ATTENTION:
        return snap.attention;
      default:
        return [];
    }
  }

  /* ------------------------------------------------------------ helpers */

  const preview = (rows) => (rows || []).slice(0, PREVIEW_LIMIT);

  /**
   * A TOTAL ORDER, so pagination cannot repeat or drop a row.
   *
   * Gaps first and longest-waiting first is the useful reading order; the
   * employee id breaks every remaining tie, which is what makes page 2 disjoint
   * from page 1 even when a dozen rows share a start time.
   */
  function orderForDisplay(rows) {
    return (rows || []).slice().sort(
      (a, b) =>
        (b.gap_class !== GAP.COVERED) - (a.gap_class !== GAP.COVERED) ||
        (b.minutes_since_start || 0) - (a.minutes_since_start || 0) ||
        a.employee_id - b.employee_id
    );
  }

  function byName(rows) {
    return (rows || [])
      .slice()
      .sort(
        (a, b) =>
          String(a.employee_name || "").localeCompare(String(b.employee_name || "")) ||
          a.employee_id - b.employee_id
      );
  }

  const employeeRow = (employee) => ({
    employee_id: Number(employee.employee_id),
    employee_name: employee.employee_name,
    store_id: employee.store_id === null || employee.store_id === undefined ? null : Number(employee.store_id),
    outlet_name: employee.outlet_name || employee.outlet_nickname || null,
    designation_id:
      employee.designation_id === null || employee.designation_id === undefined
        ? null
        : Number(employee.designation_id),
    designation_name: employee.designation_name || null,
  });

  /**
   * The recorded state from the session that actually describes this employee
   * now, plus where its latest counted punch happened.
   *
   * The SELECTION is `selectSession` in the pure layer - canonical attendance
   * ownership, newest relevant session, ambiguity reported rather than guessed.
   * This function only reads the chosen session and attaches the location.
   */
  function observe({ candidates, active, punchLocations, locationsAvailable }) {
    const chosen = selectSession(candidates, { active });
    const none = {
      state: RECORDED.NONE,
      since_minute: null,
      count: 0,
      now_minute: active ? active.now_minute : 0,
      punch_outlet_id: null,
      punch_outlet_name: null,
      location_known: false,
      location_basis: LOCATION_BASIS.UNKNOWN,
      ambiguous: false,
      attendance_date: null,
      session_reason: chosen.reason,
    };
    if (!chosen.candidate) return none;

    const candidate = chosen.candidate;
    const observed = recordedStateAsOf(candidate.punches, candidate.now_minute);
    const location = observed.last ? punchLocations.get(String(observed.last.punch_id)) : null;

    // HOW the place is known, which is not the same question as WHERE. An
    // approved regularization had no terminal at all, so there is no device
    // location to look up and none is invented; `classifyExpected` treats that
    // basis on its own terms rather than as an unmapped terminal.
    const regularized = !!(observed.last && observed.last.source === PUNCH_SOURCE.REGULARIZED);
    const deviceKnown = !!(locationsAvailable && location && location.outlet_id !== null);
    const basis = regularized
      ? LOCATION_BASIS.APPROVED_REGULARIZATION
      : deviceKnown
      ? LOCATION_BASIS.DEVICE
      : LOCATION_BASIS.UNKNOWN;

    return {
      ...observed,
      now_minute: candidate.now_minute,
      attendance_date: candidate.attendance_date,
      punch_outlet_id: location ? location.outlet_id : null,
      punch_outlet_name: location ? location.outlet_name : null,
      // A DEVICE punch whose terminal has no outlet mapping, or whose location
      // could not be read at all, tells us the STATE but not the PLACE.
      location_known: deviceKnown,
      location_basis: basis,
      ambiguous: chosen.ambiguous,
      session_reason: chosen.reason,
    };
  }

  /** Location x role coverage - the main comparison. */
  function buildCoverage(rostered, deliveryByOutlet) {
    const groups = new Map();
    (rostered || []).forEach((r) => {
      const key = `${outletKeyOf(r.store_id)}|${roleKeyOf(r.designation_id)}`;
      if (!groups.has(key)) {
        groups.set(key, {
          store_id: r.store_id,
          outlet_name: r.outlet_name || "No outlet on record",
          designation_id: r.designation_id,
          designation_name: r.designation_name || "No role on record",
          rows: [],
        });
      }
      groups.get(key).rows.push(r);
    });

    return [...groups.values()]
      .map((g) => {
        const t = reconcileGap(g.rows);
        return {
          store_id: g.store_id,
          outlet_name: g.outlet_name,
          designation_id: g.designation_id,
          designation_name: g.designation_name,
          expected_now: t.expected,
          recorded_in: t.recorded_in_at_expected,
          recorded_in_location_unverified: t.recorded_in_location_unverified,
          gap: t.gap,
          gap_by_class: t.by_class,
          reconciles: t.reconciles,
          delivery: deliveryByOutlet.get(outletKeyOf(g.store_id)) || DELIVERY.UNVERIFIED,
        };
      })
      .sort((a, b) => b.gap - a.gap || b.expected_now - a.expected_now);
  }

  /**
   * B. THE NEXT 60 MINUTES, from the whole relevant schedule on one axis.
   *
   * Every count is a SCHEDULE count. Nothing here says who will turn up.
   */
  function buildNextHour(snap) {
    const next = upcomingTransitions(
      snap.scheduled_outlook,
      snap.now_absolute === undefined ? snap.now_minute : snap.now_absolute,
      NEXT_WINDOW_MINUTES
    );
    return {
      window_minutes: NEXT_WINDOW_MINUTES,
      next_change_at: minuteToClock(next.next_change_minute),
      transitions: next.transitions.slice(0, 8).map((t) => ({
        at: minuteToClock(t.minute),
        starting: t.starting.length,
        finishing: t.finishing.length,
        remaining: t.remaining.length,
        starting_by_role: rolesOf(t.starting),
        finishing_by_role: rolesOf(t.finishing),
        remaining_by_role: rolesOf(t.remaining),
        starting_by_location: locationsOf(t.starting),
        finishing_by_location: locationsOf(t.finishing),
        remaining_by_location: locationsOf(t.remaining),
      })),
    };
  }

  /** A short, factual line per gap. No penalty, no interpretation. */
  function gapExplanation(row) {
    switch (row.gap_class) {
      case GAP.NO_CHECK_IN:
        return `No check-in received — ${row.minutes_since_start || 0} minutes since shift start`;
      case GAP.RECORDED_OUT:
        return `Recorded OUT — ${row.recorded_minutes || 0} minutes since the latest valid OUT`;
      case GAP.IN_ELSEWHERE:
        return `Recorded IN at ${row.punch_outlet_name || "another location"} — verification needed`;
      case GAP.IN_LOCATION_UNKNOWN:
        return "Recorded IN, but the punch location is not established — verification needed";
      case GAP.EXPECTED_LOCATION_UNKNOWN:
        return "Recorded IN, but this employee has no outlet on record — setup needed";
      case GAP.INDETERMINATE:
        return "The relevant punch session cannot be established — verification needed";
      default:
        return null;
    }
  }

  /** `{role, count}` for a set of scheduled rows. */
  function rolesOf(rows) {
    return countBy(rows, (r) => r.designation_name || "No role on record", "role");
  }

  /** `{location, count}` for a set of scheduled rows. */
  function locationsOf(rows) {
    return countBy(rows, (r) => r.outlet_name || "No outlet on record", "location");
  }

  function countBy(rows, keyOf, field) {
    const out = new Map();
    (rows || []).forEach((r) => {
      const k = keyOf(r);
      out.set(k, (out.get(k) || 0) + 1);
    });
    return [...out.entries()].map(([k, count]) => ({ [field]: k, count }));
  }

  /* ------------------------------ F. needs attention now --------------- */

  /**
   * WHAT NEEDS SOMEBODY NOW, from states that already exist.
   *
   * NOT A NEW WORKFLOW. Every item is read from data the dashboard already
   * loads, and every item points at the screen that owns the action - the
   * approval queue, the OT queue, shift assignment, or the employee's own
   * attendance detail. Nothing is approved, rejected, regularized or modified
   * from here.
   *
   * AN OWNER IS SHOWN ONLY WHERE THE SYSTEM NAMES ONE. For a waiting approval
   * that is the approver on the request's own currently-pending step, read from
   * `attendance_approval_step`. For an operational item - a missing check-in, a
   * shift with no schedule row - the system names nobody, so nobody is named. A
   * plausible-looking owner would be an invention, and an invented owner is how
   * a real person gets chased for somebody else's task.
   *
   * MISSING PUNCH IS ONLY REPORTED ON A CLOSED SESSION. An odd punch count
   * during a running shift is somebody at work; `dashboardIssueKey` already
   * gates that and is reused rather than restated.
   *
   * PAYROLL READINESS IS DELIBERATELY ABSENT. The scope allows it "only if a
   * real existing readiness state is already available", and there is none: no
   * stored readiness verdict exists, and computing one would need the separate
   * payroll permission and a monthly roll-up this snapshot does not load.
   */
  const buildAttention = async ({
    byEmployee,
    rostered,
    unknownExpectation,
    businessDate,
    previousDate,
    now,
  }) => {
    const items = [];
    const rosteredById = new Map(rostered.map((r) => [String(r.employee_id), r]));

    unknownExpectation.forEach((r) => {
      items.push({
        ...r,
        reason_key: ATTENTION.SHIFT_SETUP,
        reason: ATTENTION_LABEL.SHIFT_SETUP,
        detail: r.reason,
        target: ATTENTION_TARGET.SHIFT_SETUP,
        age_minutes: null,
        owner_name: null,
      });
    });

    rostered.forEach((r) => {
      const key =
        r.gap_class === GAP.NO_CHECK_IN
          ? ATTENTION.NO_CHECK_IN
          : r.gap_class === GAP.IN_ELSEWHERE
          ? ATTENTION.IN_ELSEWHERE
          : r.gap_class === GAP.IN_LOCATION_UNKNOWN
          ? ATTENTION.IN_LOCATION_UNKNOWN
          : r.gap_class === GAP.EXPECTED_LOCATION_UNKNOWN
          ? ATTENTION.EXPECTED_LOCATION_UNKNOWN
          : r.gap_class === GAP.INDETERMINATE
          ? ATTENTION.INDETERMINATE
          : null;
      if (!key) return;
      items.push({
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        store_id: r.store_id,
        outlet_name: r.outlet_name,
        designation_id: r.designation_id,
        designation_name: r.designation_name,
        attendance_date: r.attendance_date,
        reason_key: key,
        reason: ATTENTION_LABEL[key],
        detail: gapExplanation(r),
        target: ATTENTION_TARGET[key],
        age_minutes: key === ATTENTION.NO_CHECK_IN ? r.minutes_since_start : r.recorded_minutes,
        owner_name: null,
      });
    });

    /* ------ waiting approvals and settled missing punches, per date ----- */

    const pendingRequestIds = [];
    const dateOf = new Map();

    byEmployee.forEach(({ employee, days }) => {
      [businessDate, previousDate].forEach((date) => {
        const day = days[date];
        if (!day) return;

        const closed = isDayClosed({
          attendance_date: date,
          snapshot: day.shift_snapshot || null,
          now,
        });

        // A WAITING REQUEST, not a day status. The day's own status only reads
        // REGULARIZATION_PENDING on an odd punch count, so keying off it would
        // hide every request raised against an even-count day.
        if (day.regularization_request_id && day.regularization_request_pending) {
          pendingRequestIds.push(day.regularization_request_id);
          dateOf.set(String(day.regularization_request_id), {
            employee,
            date,
            key: ATTENTION.REGULARIZATION_PENDING,
          });
        }
        if (day.ot_request_pending && day.ot_request_id) {
          pendingRequestIds.push(day.ot_request_id);
          dateOf.set(String(day.ot_request_id), { employee, date, key: ATTENTION.OT_PENDING });
        }

        const issue = dashboardIssueKey(day, { day_closed: closed });
        if (issue === ISSUE_KEY.MISSING_PUNCH) {
          items.push({
            ...employeeRow(employee),
            attendance_date: date,
            reason_key: ATTENTION.MISSING_PUNCH,
            reason: ATTENTION_LABEL.MISSING_PUNCH,
            detail: `An odd number of punches on a closed attendance day (${date})`,
            target: ATTENTION_TARGET.MISSING_PUNCH,
            age_minutes: null,
            owner_name: null,
          });
        }
      });
    });

    // The approver the system itself names for each waiting request. One read,
    // and a failure loses the NAME, never the item.
    const approverByRequest = new Map();
    if (pendingRequestIds.length > 0 && attendanceDashboardRepo.listPendingApproversForRequests) {
      try {
        const rows = await attendanceDashboardRepo.listPendingApproversForRequests([
          ...new Set(pendingRequestIds),
        ]);
        (rows || []).forEach((row) => {
          approverByRequest.set(String(row.attendance_approval_request_id), row);
        });
      } catch (err) {
        // No owner names. The items still appear.
      }
    }

    dateOf.forEach((entry, requestId) => {
      const approver = approverByRequest.get(String(requestId));
      items.push({
        ...employeeRow(entry.employee),
        attendance_date: entry.date,
        reason_key: entry.key,
        reason: ATTENTION_LABEL[entry.key],
        detail:
          entry.key === ATTENTION.OT_PENDING
            ? "An overtime claim is waiting for a decision"
            : "A regularization request is waiting for a decision",
        target: ATTENTION_TARGET[entry.key],
        request_id: Number(requestId),
        age_minutes: approver ? pendingMinutes(approver.created_at, now) : null,
        owner_name: approver ? approver.approver_name || null : null,
      });
    });

    const rank = (item) => ATTENTION_ORDER.indexOf(item.reason_key);
    return items.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.age_minutes || 0) - (a.age_minutes || 0) ||
        a.employee_id - b.employee_id
    );
  };

  /** Minutes a request has been waiting, from the request's own created_at. */
  function pendingMinutes(createdAt, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(createdAt || ""));
    if (!m) return null;
    // `created_at` is already IST wall-clock from the repository, so it is
    // compared against IST wall-clock rather than being re-offset.
    const parts = istNowParts(now);
    const created = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    const nowWall = Date.UTC(
      Number(parts.date.slice(0, 4)),
      Number(parts.date.slice(5, 7)) - 1,
      Number(parts.date.slice(8, 10)),
      0,
      parts.minutes
    );
    return Math.max(0, Math.round((nowWall - created) / 60000));
  }

  /* ------------------------------- E. recurring coverage gaps ---------- */

  /**
   * Repeated (location, role, time band) shortfalls against the SCHEDULE.
   *
   * WHAT IT MEASURES. On each comparable past day - the same weekday, so a
   * Saturday is compared with Saturdays - it replays the same two questions
   * this dashboard asks live, AT THE SAME INSTANT: at the midpoint of a band,
   * how many were on duty, and how many of those were recorded IN.
   *
   * THE TWO DEFECTS THIS REPLACES, both of which manufactured shortfalls:
   *
   *   THE POPULATION was resolved once, for the most recent comparison date,
   *   and reused for all of them - so a mid-window joiner was counted as
   *   expected on days before they joined, and a leaver after they left. Each
   *   date now resolves its own applicable employees, through the same
   *   employment rule the trend and the single-date overview use.
   *
   *   THE BAND counted anyone whose shift OVERLAPPED it, then checked their
   *   punch state only at the MIDPOINT. An employee starting at 09:30 was
   *   therefore expected at 09:00 - half an hour before their shift - and
   *   recorded as a shortfall for it. Expectation and observation are now read
   *   at the same minute: the midpoint, and only if the duty interval contains
   *   it.
   *
   * WHAT IT DOES NOT MEASURE. Whether the schedule itself was adequate. That
   * is a staffing requirement, it does not exist yet, and it belongs to the
   * budgeting phase. It is not an employee attendance-performance score and is
   * never presented as one.
   *
   * THE EVIDENCE IS SHOWN, NOT SUMMARISED INTO A SCORE. Every row carries the
   * dates it was observed on, the expected and recorded counts for each, and
   * how many comparable days were examined - so a reader can see what the
   * statement rests on instead of trusting a number.
   *
   * AND THE EVIDENCE FAILS CLOSED. Punch retrieval that is unfinished or failed
   * excludes the affected date outright; retrieval status that cannot be READ
   * at all makes the whole panel unavailable rather than optimistic. Delivery
   * completeness cannot be proven even on undisturbed dates, so the limitation
   * travels with every row.
   */
  const BAND_MINUTES = 120;
  const DEFAULT_COMPARABLE_DAYS = 4;
  const MIN_OCCURRENCES = 2;

  const getRecurringGaps = async ({
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    comparable_days = DEFAULT_COMPARABLE_DAYS,
    now = Date.now(),
  } = {}) => {
    const nowParts = istNowParts(now);
    const today = nowParts.date;
    const days = Math.max(2, Math.min(8, Math.trunc(Number(comparable_days) || DEFAULT_COMPARABLE_DAYS)));

    const LIMITATION =
      "This compares recorded attendance against the SCHEDULE - not whether the schedule was " +
      "adequate, and not any employee's performance. Observed recorded coverage against " +
      "schedule; punch delivery completeness cannot be verified, so a shortfall may be a gap " +
      "in the data rather than in the cover. Days with an unfinished or failed punch retrieval " +
      "are excluded, and if retrieval status cannot be read at all nothing is reported. Rejoin " +
      "history is not reconstructed: an employee who left and returned inside the window is " +
      "included on the dates the employment rule makes them applicable, and no finer precision " +
      "is claimed.";

    const empty = (reason) => ({
      as_of: `${today} ${minuteToClock(nowParts.minutes)}`,
      comparable_days: days,
      dates_examined: [],
      dates_excluded: [],
      patterns: [],
      available: false,
      reason,
      basis: `Same weekday as today, the ${days} most recent completed ones.`,
      limitation: LIMITATION,
    });

    if (Array.isArray(store_ids) && store_ids.length === 0) return empty("NO_SCOPE");

    // The same weekday, most recent first, excluding today (it is not finished).
    const dates = [];
    for (let i = 1; dates.length < days && i <= days * 7 + 7; i += 1) {
      const d = addDays(today, -i);
      if (dayDelta(today, d) % 7 === 0) dates.push(d);
    }
    if (dates.length === 0) return empty("NO_COMPARABLE_DAYS");

    // Retrieval status FIRST: if it cannot be read, nothing below is evidence.
    let pulls = [];
    let pullsReadable = true;
    const oldest = dates[dates.length - 1];
    try {
      pulls = attendanceDashboardRepo.listHistoricalPullsForRange
        ? await attendanceDashboardRepo.listHistoricalPullsForRange({
            from_date: oldest,
            to_date: dates[0],
            store_ids,
          })
        : [];
    } catch (err) {
      pullsReadable = false;
    }
    if (!pullsReadable) return empty("PULL_STATUS_UNREADABLE");

    // Every row the repository returns is a pull that did NOT complete - the
    // query excludes COMPLETED - so both IN_PROGRESS and FAILED land here and
    // both disqualify the dates they cover.
    const disturbed = new Set();
    (pulls || []).forEach((pull) => {
      dates.forEach((date) => {
        const from = /^(\d{4}-\d{2}-\d{2})/.exec(String(pull.requested_from || ""));
        const to = /^(\d{4}-\d{2}-\d{2})/.exec(String(pull.requested_to || ""));
        if (from && from[1] > date) return;
        if (to && to[1] < date) return;
        disturbed.add(date);
      });
    });
    const usable = dates.filter((d) => !disturbed.has(d));
    if (usable.length === 0) return empty("NO_UNDISTURBED_DAYS");

    /* ---- PER-DATE populations. The applicability rule, per date. ------- */

    const populations = new Map();
    for (const date of usable) {
      // Sequential on purpose: one modest query per comparison day, at most
      // eight, against a repository that is not built for fan-out.
      // eslint-disable-next-line no-await-in-loop
      const rows = await attendanceDashboardRepo.listApplicableEmployees({
        attendance_date: date,
        store_ids,
        designation_id,
        search,
      });
      populations.set(date, rows || []);
    }

    const union = new Map();
    populations.forEach((rows) => {
      rows.forEach((e) => union.set(String(e.employee_id), e));
    });
    if (union.size === 0) return empty("NO_POPULATION");

    const batch = await dashboardUsecase.loadBatch({
      employees: [...union.values()],
      from: oldest,
      to: dates[0],
    });

    // group key -> per-date observation
    const observations = new Map();

    usable.forEach((date) => {
      (populations.get(date) || []).forEach((employee) => {
        const [day] = dashboardUsecase.computeDaysForEmployee({
          employee,
          dates: [date],
          batch,
        });
        if (work_shift_id !== null && Number(day.work_shift_id) !== Number(work_shift_id)) return;

        const interval = dutyInterval(day.shift_snapshot || null);
        if (!interval) return;

        const punches = (day.effective_punches || []).map((pn) => ({
          punch_id: pn.punch_id,
          minute: minuteOnAxis(date, pn.io_time),
        }));

        // Bands span the attendance date's OWN extended axis, so an overnight
        // shift's small hours are observed on the date that owns them and are
        // labelled by the clock time they actually happened at.
        for (let bandStart = 0; bandStart < 2 * MINUTES_PER_DAY; bandStart += BAND_MINUTES) {
          const mid = bandStart + BAND_MINUTES / 2;
          // EXPECTED AND RECORDED ARE READ AT THE SAME MINUTE. Overlapping the
          // band is not enough: the duty interval must contain the midpoint.
          if (!onDutyAt(interval, mid)) continue;

          const label = `${minuteToClock(bandStart)}|${minuteToClock(bandStart + BAND_MINUTES)}`;
          const key = `${outletKeyOf(employee.store_id)}|${roleKeyOf(employee.designation_id)}|${label}`;
          if (!observations.has(key)) {
            observations.set(key, {
              store_id: employee.store_id === null ? null : Number(employee.store_id),
              outlet_name: employee.outlet_name || "No outlet on record",
              designation_id:
                employee.designation_id === null ? null : Number(employee.designation_id),
              designation_name: employee.designation_name || "No role on record",
              band_from: minuteToClock(bandStart),
              band_to: minuteToClock(bandStart + BAND_MINUTES),
              perDate: new Map(),
            });
          }
          const group = observations.get(key);
          if (!group.perDate.has(date)) group.perDate.set(date, { expected: 0, recorded: 0 });
          const cell = group.perDate.get(date);
          cell.expected += 1;
          if (recordedStateAsOf(punches, mid).state === RECORDED.IN) cell.recorded += 1;
        }
      });
    });

    const patterns = [...observations.values()]
      .map((g) => {
        const observed = [...g.perDate.entries()]
          .map(([date, cell]) => ({ attendance_date: date, ...cell, short: cell.recorded < cell.expected }))
          .sort((a, b) => (a.attendance_date < b.attendance_date ? 1 : -1));
        const shortDays = observed.filter((o) => o.short);
        return {
          store_id: g.store_id,
          outlet_name: g.outlet_name,
          designation_id: g.designation_id,
          designation_name: g.designation_name,
          band_from: g.band_from,
          band_to: g.band_to,
          days_examined: observed.length,
          days_short: shortDays.length,
          observations: observed,
        };
      })
      .filter((p) => p.days_short >= MIN_OCCURRENCES)
      .sort((a, b) => b.days_short - a.days_short || b.days_examined - a.days_examined)
      .slice(0, 20);

    return {
      as_of: `${today} ${minuteToClock(nowParts.minutes)}`,
      comparable_days: days,
      dates_examined: usable,
      dates_excluded: [...disturbed],
      patterns,
      available: true,
      reason: patterns.length === 0 ? "NO_REPEATED_PATTERN" : null,
      applied_filters: {
        store_ids,
        designation_id:
          designation_id === null || designation_id === undefined ? null : Number(designation_id),
        work_shift_id:
          work_shift_id === null || work_shift_id === undefined ? null : Number(work_shift_id),
        search: search || null,
      },
      basis:
        `Same weekday as today, the ${usable.length} most recent completed ones. Each date uses ` +
        `its own applicable employees. A ${BAND_MINUTES / 60}-hour band counts as short on a day ` +
        `when fewer employees were recorded IN at its midpoint than were ON DUTY at that same ` +
        `midpoint. A pattern is reported from ${MIN_OCCURRENCES} short days upward.`,
      limitation: LIMITATION,
    };
  };

  return {
    NEXT_WINDOW_MINUTES,
    PREVIEW_LIMIT,
    DRILLDOWN_MAX_LIMIT,
    DRILLDOWN_DEFAULT_LIMIT,
    BUCKET,
    BUCKET_LABEL,
    BUCKETS,
    ATTENTION,
    ATTENTION_LABEL,
    ATTENTION_TARGET,
    ATTENTION_ORDER,
    getSnapshot,
    getStaffingDrilldown,
    getRecurringGaps,
    loadSnapshotContext,
    resolveDelivery,
  };
};
