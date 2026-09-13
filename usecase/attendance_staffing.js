const { addDays, dayDelta } = require("../utils/attendance_engine");
const { toDateOnly } = require("../utils/shiftResolution");
const {
  DELIVERY,
  DELIVERY_DETAIL,
  DELIVERY_LABEL,
  istNowParts,
  locationDelivery,
} = require("../utils/attendance_dashboard");
const {
  GAP,
  GAP_CLASSES,
  GAP_LABEL,
  RECORDED,
  activeDuty,
  classifyExpected,
  dutyInterval,
  elapsedSince,
  minuteToClock,
  recordedStateAsOf,
  reconcileGap,
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
 * THE WINDOW. Two attendance dates are always considered - the business date
 * and the one before it - because the shift on duty at 01:00 began yesterday.
 * The engine decides which punches belong to which of them; this file decides
 * which of them is currently on duty.
 */
const NEXT_WINDOW_MINUTES = 60;
const MAX_LIST = 200;

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
  return delta * 1440 + Number(m[2]) * 60 + Number(m[3]);
}

module.exports = (attendanceDashboardRepo, dashboardUsecase) => {
  /**
   * Everything the snapshot needs for one business date and the one before it.
   *
   * The population is the applicable employees for the business date; the
   * engine days are computed for BOTH dates so a shift that began yesterday
   * and is still running can be found and its punches read.
   */
  const loadSnapshotContext = async ({ businessDate, filters, now }) => {
    const previousDate = addDays(businessDate, -1);

    const employees = await attendanceDashboardRepo.listApplicableEmployees({
      attendance_date: businessDate,
      store_ids: filters.store_ids,
      designation_id: filters.designation_id,
      search: filters.search,
    });
    if (!employees || employees.length === 0) {
      return { employees: [], byEmployee: new Map(), punchLocations: new Map(), previousDate };
    }

    const batch = await dashboardUsecase.loadBatch({
      employees,
      from: previousDate,
      to: businessDate,
    });

    const byEmployee = new Map();
    employees.forEach((employee) => {
      const [prev, today] = dashboardUsecase.computeDaysForEmployee({
        employee,
        dates: [previousDate, businessDate],
        batch,
      });
      byEmployee.set(String(employee.employee_id), { employee, days: { [previousDate]: prev, [businessDate]: today } });
    });

    // Where each punch happened, so a cross-location arrival can be told from
    // cover. A terminal with no outlet mapping yields no entry, and the caller
    // treats that as "location not known" rather than as "somewhere else".
    const punchIds = [];
    byEmployee.forEach(({ days }) => {
      Object.values(days).forEach((day) => {
        (day.effective_punches || []).forEach((p) => {
          if (p.punch_id !== null && p.punch_id !== undefined) punchIds.push(p.punch_id);
        });
      });
    });

    const punchLocations = new Map();
    if (punchIds.length > 0 && attendanceDashboardRepo.listPunchesByIds) {
      try {
        const rows = await attendanceDashboardRepo.listPunchesByIds([...new Set(punchIds)]);
        (rows || []).forEach((r) => {
          punchLocations.set(String(r.punch_id), {
            outlet_id: r.punch_outlet_id === null || r.punch_outlet_id === undefined
              ? null
              : Number(r.punch_outlet_id),
            outlet_name: r.punch_outlet_name || null,
            device_label: r.device_label || r.dev_id || null,
          });
        });
      } catch (err) {
        // No locations known: every recorded IN counts as cover, and the
        // cross-location panel says it has nothing to show. Under-claiming.
      }
    }

    return { employees, byEmployee, punchLocations, previousDate };
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

  /**
   * THE SNAPSHOT.
   *
   * @param {object} input
   * @param {number[]|null} input.store_ids  the caller's resolved scope
   * @param {number} [input.now]             injectable clock
   */
  const getSnapshot = async ({
    store_ids = null,
    designation_id = null,
    work_shift_id = null,
    search = null,
    now = Date.now(),
  } = {}) => {
    const nowParts = istNowParts(now);
    const businessDate = nowParts.date;
    const asOf = `${businessDate} ${minuteToClock(nowParts.minutes)}`;

    const empty = (reason) => ({
      as_of: asOf,
      business_date: businessDate,
      expected_now: 0,
      recorded_in: 0,
      gap: 0,
      reconciles: true,
      gap_by_class: GAP_CLASSES.map((c) => ({ key: c, label: GAP_LABEL[c], count: 0 })),
      coverage: [],
      expected_detail: [],
      additional: { early: [], no_active_shift: [], cross_location_arrivals: [] },
      unknown_expectation: [],
      next_hour: { next_change_at: null, transitions: [] },
      gap_detail: [],
      delivery: [],
      delivery_available: true,
      reason,
    });

    // An empty authorized scope reads nothing.
    if (Array.isArray(store_ids) && store_ids.length === 0) return empty("NO_SCOPE");

    const filters = { store_ids, designation_id, search };
    const ctx = await loadSnapshotContext({ businessDate, filters, now });
    if (ctx.employees.length === 0) return empty("NO_POPULATION");

    const previousDate = ctx.previousDate;
    const nowOn = (date) => dayDelta(date, businessDate) * 1440 + nowParts.minutes;

    /* ---------- who is on duty, and what is recorded for them ---------- */

    const rostered = []; // expected now
    const unknownExpectation = []; // shift could not be resolved
    const additionalEarly = [];
    const additionalNoShift = [];

    ctx.byEmployee.forEach(({ employee, days }) => {
      const candidates = [businessDate, previousDate].map((date) => ({
        attendance_date: date,
        snapshot: days[date] ? days[date].shift_snapshot : null,
        now_minute: nowOn(date),
        day: days[date],
      }));

      // An unresolvable shift is EXPECTED COVERAGE UNKNOWN, never zero
      // expected. Reported on its own list so a setup fault cannot quietly
      // shrink the headcount everybody is being measured against.
      const todaysDay = days[businessDate];
      const unresolved =
        todaysDay &&
        (todaysDay.shift_resolution_status === "NO_SHIFT_FOR_DATE" ||
          todaysDay.shift_resolution_status === "NO_SCHEDULE_ROW");

      const duty = activeDuty(candidates);

      if (!duty) {
        if (unresolved) {
          unknownExpectation.push({
            ...employeeRow(employee),
            reason:
              todaysDay.shift_resolution_status === "NO_SHIFT_FOR_DATE"
                ? "No shift assigned for this date"
                : "The shift has no schedule row for this weekday",
          });
        }
        // Recorded IN with no active shift: an early arrival if their own
        // shift starts later today, otherwise simply somebody recorded IN
        // without a currently active shift. Either way NOT expected cover.
        const observed = observeEmployee({ days, candidates, punchLocations: ctx.punchLocations });
        if (observed && observed.state === RECORDED.IN) {
          const todaysInterval = dutyInterval(todaysDay ? todaysDay.shift_snapshot : null);
          const target =
            todaysInterval && nowOn(businessDate) < todaysInterval.start
              ? additionalEarly
              : additionalNoShift;
          target.push({
            ...employeeRow(employee),
            recorded_since: minuteToClock(observed.since_minute),
            recorded_minutes: elapsedSince(observed.since_minute, observed.now_minute),
            punch_outlet_id: observed.punch_outlet_id,
            punch_outlet_name: observed.punch_outlet_name,
            scheduled_start: todaysInterval ? minuteToClock(todaysInterval.start) : null,
          });
        }
        return;
      }

      if (work_shift_id !== null && Number(duty.day.work_shift_id) !== Number(work_shift_id)) return;

      const observed = observeEmployee({
        days,
        candidates: [duty],
        punchLocations: ctx.punchLocations,
      });

      const gapClass = classifyExpected({
        recorded_state: observed.state,
        punch_outlet_id: observed.punch_outlet_id,
        expected_outlet_id: employee.store_id === null ? null : Number(employee.store_id),
        location_known: observed.location_known,
      });

      rostered.push({
        ...employeeRow(employee),
        attendance_date: duty.attendance_date,
        interval: duty.interval,
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

    /* ------------------------------------------------- the headline ----- */

    const totals = reconcileGap(rostered);

    /* --------------------------------- location x role coverage (A) ----- */

    const coverage = buildCoverage(rostered, delivery.byOutlet);

    /* ------------------------------------------- next 60 minutes (B) ---- */

    const next = upcomingTransitions(
      rostered.map((r) => ({ ...r, interval: r.interval })),
      // Transitions are compared on the axis of the date each interval sits
      // on; the rostered rows already carry intervals on their own date, and
      // every currently-active interval contains "now", so one axis is enough.
      rostered.length ? nowOn(rostered[0].attendance_date) : nowParts.minutes,
      NEXT_WINDOW_MINUTES
    );

    /* ------------------------------------------- gap detail (C) --------- */

    // THE WHOLE EXPECTED ROSTER, each row carrying its own classification, so
    // the screen can list "expected", "recorded IN" and "gap" from one payload
    // without asking a dated endpoint a question about "now".
    const expectedDetail = rostered
      .map((r) => ({ ...r, explanation: r.gap_class === GAP.COVERED ? null : gapExplanation(r) }))
      .sort(
        (a, b) =>
          (b.gap_class !== GAP.COVERED) - (a.gap_class !== GAP.COVERED) ||
          (b.minutes_since_start || 0) - (a.minutes_since_start || 0)
      )
      .slice(0, MAX_LIST);

    const gapDetail = expectedDetail.filter((r) => r.gap_class !== GAP.COVERED);

    /* --------------------------------- cross-location arrivals (D) ------ */

    const crossLocation = rostered
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

    return {
      as_of: asOf,
      business_date: businessDate,

      expected_now: totals.expected,
      recorded_in: totals.recorded_in_at_expected,
      gap: totals.gap,
      reconciles: totals.reconciles,
      gap_by_class: totals.by_class,

      coverage,
      expected_detail: expectedDetail,
      gap_detail: gapDetail,
      next_hour: {
        next_change_at: minuteToClock(next.next_change_minute),
        transitions: next.transitions.slice(0, 8).map((t) => ({
          at: minuteToClock(t.minute),
          starting: t.starting.length,
          finishing: t.finishing.length,
          remaining: t.remaining.length,
          remaining_by_role: rolesOf(t.remaining),
          starting_by_role: rolesOf(t.starting),
          finishing_by_role: rolesOf(t.finishing),
        })),
      },

      additional: {
        early: additionalEarly.slice(0, MAX_LIST),
        no_active_shift: additionalNoShift.slice(0, MAX_LIST),
        cross_location_arrivals: crossLocation.slice(0, MAX_LIST),
      },
      unknown_expectation: unknownExpectation.slice(0, MAX_LIST),

      delivery: [...delivery.byOutlet.entries()].map(([key, verdict]) => ({
        store_id: key === "none" ? null : Number(key),
        delivery: verdict,
        label: DELIVERY_LABEL[verdict],
        detail: DELIVERY_DETAIL[verdict],
      })),
      delivery_available: delivery.available,

      definitions: {
        expected_now:
          "Applicable employees whose assigned duty interval contains the as-of time: shift start <= now < shift end. The interval is the shift's own in-time to out-time - not normal hours, and not reduced by a break allowance.",
        recorded_in:
          "Expected employees whose latest interpretable punch state as of now is an IN, at their expected duty location. Recorded IN does NOT mean actively working or available at a counter.",
        gap:
          "Expected Now minus Recorded IN at the expected location, broken into mutually exclusive reasons. It is 'not recorded IN against schedule' - not absence, and not a confirmed shortage.",
        delivery:
          "Whether punches for this date are known to have all arrived. This system has no end-of-transfer acknowledgement, so the answer is never 'confirmed'.",
      },
    };
  };

  /* ------------------------------------------------------------ helpers */

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
   * The recorded state for whichever candidate session is relevant, plus where
   * the latest counted punch happened.
   */
  function observeEmployee({ days, candidates, punchLocations }) {
    let best = null;
    (candidates || []).forEach((candidate) => {
      const day = candidate.day || (days ? days[candidate.attendance_date] : null);
      if (!day) return;
      const punches = (day.effective_punches || []).map((p) => ({
        punch_id: p.punch_id,
        io_time: p.io_time,
        source: p.source,
        minute: minuteOnAxis(candidate.attendance_date, p.io_time),
      }));
      const observed = recordedStateAsOf(punches, candidate.now_minute);
      if (observed.state === RECORDED.NONE && best) return;
      if (!best || observed.count > 0) {
        const location = observed.last ? punchLocations.get(String(observed.last.punch_id)) : null;
        best = {
          ...observed,
          now_minute: candidate.now_minute,
          punch_outlet_id: location ? location.outlet_id : null,
          punch_outlet_name: location ? location.outlet_name : null,
          // A punch whose terminal has no outlet mapping tells us the STATE
          // but not the PLACE; treating unknown as "elsewhere" would invent
          // cross-location findings out of unmapped hardware.
          location_known: !!(location && location.outlet_id !== null),
        };
      }
    });
    return (
      best || { state: RECORDED.NONE, since_minute: null, count: 0, now_minute: 0, punch_outlet_id: null, punch_outlet_name: null, location_known: false }
    );
  }

  /** Location x role coverage - the main comparison. */
  function buildCoverage(rostered, deliveryByOutlet) {
    const groups = new Map();
    rostered.forEach((r) => {
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
          gap: t.gap,
          gap_by_class: t.by_class,
          reconciles: t.reconciles,
          delivery: deliveryByOutlet.get(outletKeyOf(g.store_id)) || DELIVERY.UNVERIFIED,
        };
      })
      .sort((a, b) => b.gap - a.gap || b.expected_now - a.expected_now);
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
      default:
        return "Punch data needs verification";
    }
  }

  /** `{role: count}` for a set of rostered rows. */
  function rolesOf(rows) {
    const out = new Map();
    (rows || []).forEach((r) => {
      const name = r.designation_name || "No role on record";
      out.set(name, (out.get(name) || 0) + 1);
    });
    return [...out.entries()].map(([role, count]) => ({ role, count }));
  }

  /* ------------------------------- E. recurring coverage gaps ---------- */

  /**
   * Repeated (location, role, time band) shortfalls against the SCHEDULE.
   *
   * WHAT IT MEASURES. On each comparable past day - the same weekday, so a
   * Saturday is compared with Saturdays - it replays the same two questions
   * this dashboard asks live, at the midpoint of each band: how many were
   * rostered, and how many were recorded IN. A band counts as short on that
   * day when recorded is below expected.
   *
   * WHAT IT DOES NOT MEASURE. Whether the schedule itself was adequate. That
   * is a staffing requirement, it does not exist yet, and it belongs to the
   * budgeting phase.
   *
   * THE EVIDENCE IS SHOWN, NOT SUMMARISED INTO A SCORE. Every row carries the
   * dates it was observed on, the expected and recorded counts for each, and
   * how many comparable days were examined - so a reader can see what the
   * statement rests on instead of trusting a number.
   *
   * AND THE LIMITATION TRAVELS WITH IT. Punch delivery cannot be verified in
   * this system (see DELIVERY), so a shortfall may be a gap in the DATA rather
   * than in the cover. Days whose punch retrieval was unfinished or failed are
   * excluded outright; the rest are reported as observed, with that caveat
   * attached rather than buried.
   */
  const BAND_MINUTES = 120;
  const DEFAULT_COMPARABLE_DAYS = 4;
  const MIN_OCCURRENCES = 2;

  const getRecurringGaps = async ({
    store_ids = null,
    designation_id = null,
    search = null,
    comparable_days = DEFAULT_COMPARABLE_DAYS,
    now = Date.now(),
  } = {}) => {
    const nowParts = istNowParts(now);
    const today = nowParts.date;
    const days = Math.max(2, Math.min(8, Math.trunc(Number(comparable_days) || DEFAULT_COMPARABLE_DAYS)));

    const empty = (reason) => ({
      as_of: `${today} ${minuteToClock(nowParts.minutes)}`,
      comparable_days: days,
      dates_examined: [],
      patterns: [],
      available: false,
      reason,
      basis: `Same weekday as today, the ${days} most recent completed ones.`,
      limitation: DELIVERY_DETAIL.UNVERIFIED,
    });

    if (Array.isArray(store_ids) && store_ids.length === 0) return empty("NO_SCOPE");

    // The same weekday, most recent first, excluding today (it is not finished).
    const dates = [];
    for (let i = 1; dates.length < days && i <= days * 7 + 7; i += 1) {
      const d = addDays(today, -i);
      if (dayDelta(today, d) % 7 === 0) dates.push(d);
    }
    if (dates.length === 0) return empty("NO_COMPARABLE_DAYS");

    const employees = await attendanceDashboardRepo.listApplicableEmployees({
      attendance_date: dates[0],
      store_ids,
      designation_id,
      search,
    });
    if (!employees || employees.length === 0) return empty("NO_POPULATION");

    const oldest = dates[dates.length - 1];
    const batch = await dashboardUsecase.loadBatch({ employees, from: oldest, to: dates[0] });

    // Days whose retrieval is unfinished or failed are not evidence.
    let pulls = [];
    try {
      pulls = attendanceDashboardRepo.listHistoricalPullsForRange
        ? await attendanceDashboardRepo.listHistoricalPullsForRange({
            from_date: oldest,
            to_date: dates[0],
            store_ids,
          })
        : [];
    } catch (err) {
      pulls = [];
    }
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

    // group key -> band -> per-date observation
    const observations = new Map();

    usable.forEach((date) => {
      employees.forEach((employee) => {
        const [day] = dashboardUsecase.computeDaysForEmployee({
          employee,
          dates: [date],
          batch,
        });
        const interval = dutyInterval(day.shift_snapshot || null);
        if (!interval) return;

        const punches = (day.effective_punches || []).map((pn) => ({
          punch_id: pn.punch_id,
          minute: minuteOnAxis(date, pn.io_time),
        }));

        for (let band = 0; band * BAND_MINUTES < 1440; band += 1) {
          const bandStart = band * BAND_MINUTES;
          const bandEnd = bandStart + BAND_MINUTES;
          const mid = bandStart + Math.floor(BAND_MINUTES / 2);
          // Only bands this employee was rostered across.
          if (!(interval.start < bandEnd && interval.end > bandStart)) continue;

          const key = `${outletKeyOf(employee.store_id)}|${roleKeyOf(employee.designation_id)}|${band}`;
          if (!observations.has(key)) {
            observations.set(key, {
              store_id: employee.store_id === null ? null : Number(employee.store_id),
              outlet_name: employee.outlet_name || "No outlet on record",
              designation_id: employee.designation_id === null ? null : Number(employee.designation_id),
              designation_name: employee.designation_name || "No role on record",
              band_from: minuteToClock(bandStart),
              band_to: minuteToClock(bandEnd % 1440),
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
      basis:
        `Same weekday as today, the ${usable.length} most recent completed ones. A ` +
        `${BAND_MINUTES / 60}-hour band counts as short on a day when fewer employees were ` +
        `recorded IN at its midpoint than were rostered across it. A pattern is reported from ` +
        `${MIN_OCCURRENCES} short days upward.`,
      limitation:
        "This compares recorded attendance against the SCHEDULE - not whether the schedule was " +
        "adequate. Punch delivery cannot be verified in this system, so a shortfall may be a gap " +
        "in the data rather than in the cover. Days with an unfinished or failed punch retrieval " +
        "are excluded.",
    };
  };

  return {
    NEXT_WINDOW_MINUTES,
    getSnapshot,
    getRecurringGaps,
    loadSnapshotContext,
    resolveDelivery,
  };
};
