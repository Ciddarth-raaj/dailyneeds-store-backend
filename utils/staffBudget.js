/**
 * Staff Budget Master - Phase 1. Pure functions only: no database, no
 * Express, no display strings used as keys.
 *
 * THE MODEL. One approved headcount per
 *
 *   Location -> Department -> Designation -> Shift
 *
 * identical for every operating location, Warehouse included. Warehouse is an
 * ordinary row in `outlets`, so nothing here special-cases it and no
 * department is flattened away for it.
 *
 * APPROVED HEADCOUNT IS NOT A MEASUREMENT. It is what management approved. It
 * is never derived from who is currently employed and nothing in attendance
 * or payroll writes to it, so no function here takes an employee as input.
 *
 * WHICH SHIFT MASTER. `work_shift` - the master the attendance engine
 * actually uses. It resolves "which shift applied" from the dated
 * `employee_work_shift_assignment` history (`work_shift_id`, documented in
 * its own migration as "the NEW master, never shift_master"), the Staffing
 * Dashboard filters on the same `work_shift_id`, and neither
 * attendance_calculation nor attendance_dashboard reads `shift_master` at
 * all. Budgeting against the legacy master would key the approved headcount
 * for a shift and the attendance measured on it to two different entities.
 *
 * Its times live per weekday in `work_shift_weekly_schedule`, so the
 * checkpoint coverage is derived from that - see `representativeWindow`.
 * Every function below still takes a plain `{ in_time, out_time }` and reads
 * no table.
 *
 * PARTIAL PRICING IS NEVER PRESENTED AS A TOTAL. Only two designations have
 * agreed rates today, so a location holding five more would otherwise show
 * the sum of those two as though it were the location's staff budget. Every
 * level therefore carries `priced_monthly_budget`, `priced_headcount` and
 * `unpriced_headcount`, and `fully_priced` - which is the only thing that
 * entitles a caller to call the figure a total.
 */

const { parseTimeToMinutes, MINUTES_PER_DAY } = require("./workShift");

/**
 * The operational checkpoints, for designations that are rostered to cover a
 * trading day rather than worked to a single fixed shift.
 *
 * These are times of day, not shifts. Which shifts happen to cover them is
 * derived from each shift's own configured In/Out time, so a change to a
 * shift's timings changes the coverage with no code change here - and a shift
 * named nothing like "10-10" is still counted correctly.
 */
const CHECKPOINTS = [
  { key: "opening", label: "Opening", time: "09:00" },
  { key: "peak", label: "Peak", time: "18:00" },
  { key: "closing", label: "Closing", time: "22:00" },
];

/**
 * A work shift's operating window, for checkpoint coverage.
 *
 * `work_shift` keeps its times per weekday, so a shift has up to seven
 * windows rather than one. The approved headcount plan is not dated and not
 * per-weekday, so the coverage figures are computed against the shift's usual
 * WORKING-DAY window: rest days are ignored, and the window that occurs on
 * the most working days wins.
 *
 * `varies` says the working days do NOT all run the same hours, which the
 * screen shows so nobody reads a checkpoint figure as exact for every day of
 * the week. It is reported rather than hidden, and never silently averaged.
 *
 * Returns `{ in_time: null, out_time: null, varies: false }` for a shift with
 * no working day configured, which counts as no coverage anywhere.
 */
function representativeWindow(scheduleRows) {
  const working = (scheduleRows || []).filter(
    (row) =>
      Number(row.is_working_day) === 1 &&
      parseTimeToMinutes(row.in_time) !== null &&
      parseTimeToMinutes(row.out_time) !== null
  );

  if (working.length === 0) return { in_time: null, out_time: null, varies: false };

  const counts = new Map();
  for (const row of working) {
    const key = `${row.in_time}|${row.out_time}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let best = null;
  for (const [key, count] of counts) {
    if (best === null || count > best.count) best = { key, count };
  }

  const [in_time, out_time] = best.key.split("|");
  return { in_time, out_time, varies: counts.size > 1 };
}

/**
 * Approved headcount: an integer, zero or more, and nothing else.
 *
 * Rejects `"3.5"`, `""`, `null`, `-1` and `"abc"` alike. Returns the number,
 * or throws with a message naming what was wrong, because this is the one
 * field of this feature a person types.
 */
function validateApprovedHeadcount(value) {
  if (value === null || value === undefined || value === "") {
    throw new Error("approved_headcount is required");
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`approved_headcount must be a whole number, got "${value}"`);
  }
  if (n < 0) {
    throw new Error(`approved_headcount must be 0 or more, got ${n}`);
  }
  return n;
}

/**
 * Does a shift have somebody on the floor at `checkpoint`?
 *
 * Both ends count: a 10:00-22:00 shift is covering at 22:00 Closing, and a
 * 09:00-18:00 shift is covering at 09:00 Opening. That is the operational
 * question being asked - who is there at the moment the shutter goes up and
 * the moment it comes down - not a payroll question about the last paid
 * minute.
 *
 * A shift whose Out time is before its In time runs past midnight and is
 * treated as spanning the boundary, so a 18:00-02:00 shift covers 22:00.
 * Missing or unparseable times mean "unknown", which counts as no coverage
 * rather than as coverage: a checkpoint figure that quietly over-reports
 * staffing is the dangerous direction to be wrong in.
 */
function shiftCoversCheckpoint(shift, checkpointTime) {
  const start = parseTimeToMinutes(shift && shift.in_time);
  const end = parseTimeToMinutes(shift && shift.out_time);
  const at = parseTimeToMinutes(checkpointTime);
  if (start === null || end === null || at === null) return false;

  if (end === start) return false; // A zero-length shift covers nothing.
  if (end > start) return at >= start && at <= end;

  // Overnight: [start, midnight) plus [midnight, end].
  return at >= start || at <= end;
}

/**
 * Opening / Peak / Closing headcount for one set of shift rows.
 *
 * SIMULTANEOUS COVERAGE, WHICH IS A DIFFERENT NUMBER FROM THE TOTAL. The
 * total approved headcount is the sum across shifts - the count of approved
 * positions. A checkpoint figure is how many of those positions are on the
 * floor at that one moment, so one position on a 09:00-21:00 shift is counted
 * at Opening AND at Peak, while still being one position in the total. The
 * two are never expected to add up to each other and the screen labels them
 * apart for that reason.
 *
 * Each row is `{ approved_headcount, in_time, out_time }`.
 */
function checkpointCoverage(rows) {
  const coverage = {};
  for (const checkpoint of CHECKPOINTS) {
    coverage[checkpoint.key] = (rows || []).reduce(
      (sum, row) =>
        shiftCoversCheckpoint(row, checkpoint.time)
          ? sum + (Number(row.approved_headcount) || 0)
          : sum,
      0
    );
  }
  return coverage;
}

/** Approved positions x the monthly rate, or null when no rate is configured. */
function shiftMonthlyBudget(approved_headcount, monthly_rate) {
  if (monthly_rate === null || monthly_rate === undefined) return null;
  const rate = Number(monthly_rate);
  if (!Number.isFinite(rate)) return null;
  return (Number(approved_headcount) || 0) * rate;
}

/**
 * A fresh, empty rollup for one level of the hierarchy.
 *
 * FOUR NUMBERS, NOT ONE, and the fourth is the reason: only two designations
 * have agreed rates today, so a location holding five more would show the sum
 * of those two as though it were its staff budget. It is not - it is the
 * priced part of it. Every level therefore reports what is priced, what is
 * not, and whether the money figure is complete.
 */
function emptyRollup() {
  return {
    total_headcount: 0,
    priced_headcount: 0,
    unpriced_headcount: 0,
    priced_monthly_budget: null,
    fully_priced: true,
  };
}

/**
 * Fold one shift row into a level's rollup.
 *
 * `priced_monthly_budget` stays null until something priced arrives, so a
 * level with nothing priced reports no figure at all rather than reporting
 * zero rupees - which would read as "costs nothing" instead of "not priced".
 *
 * `fully_priced` is the flag that decides what the level's money figure may
 * be CALLED. A single unpriced approved position clears it, and only a level
 * that never saw one keeps it. Zero approved positions on an unpriced shift
 * does NOT clear it: there is no position there whose cost is unknown.
 */
function foldIntoRollup(rollup, { approved_headcount, monthly_budget }) {
  const headcount = Number(approved_headcount) || 0;
  rollup.total_headcount += headcount;

  if (monthly_budget === null || monthly_budget === undefined) {
    rollup.unpriced_headcount += headcount;
    if (headcount > 0) rollup.fully_priced = false;
    return rollup;
  }

  rollup.priced_headcount += headcount;
  rollup.priced_monthly_budget =
    (rollup.priced_monthly_budget === null ? 0 : rollup.priced_monthly_budget) +
    monthly_budget;
  return rollup;
}

/**
 * The whole screen, in one pass: flat budget rows in, the collapsible
 * hierarchy with its totals out.
 *
 * Input rows are what the repository returns - ids and the master NAMES the
 * UI displays, joined once in SQL, with the work shift's representative
 * working-day window already resolved from `work_shift_weekly_schedule`:
 *
 *   { staff_budget_id, outlet_id, outlet_name, department_id,
 *     department_name, designation_id, designation_name, work_shift_id,
 *     shift_name, shift_code, in_time, out_time, schedule_varies,
 *     approved_headcount, monthly_rate }
 *
 * `monthly_rate` is null where none is configured. Those positions count in
 * full towards headcount, are reported as `unpriced_headcount`, and clear
 * `fully_priced` on every level above them - which is the whole of the
 * intended behaviour for them, not a degraded mode.
 *
 * Ordering is by name at every level so the screen is stable between reads;
 * shifts are ordered by their In time, which is how a roster reads.
 */
function buildBudgetTree(rows) {
  const locations = new Map();

  for (const row of rows || []) {
    if (!locations.has(row.outlet_id)) {
      locations.set(row.outlet_id, {
        outlet_id: row.outlet_id,
        outlet_name: row.outlet_name,
        departments: new Map(),
        ...emptyRollup(),
      });
    }
    const location = locations.get(row.outlet_id);

    if (!location.departments.has(row.department_id)) {
      location.departments.set(row.department_id, {
        department_id: row.department_id,
        department_name: row.department_name,
        designations: new Map(),
        ...emptyRollup(),
      });
    }
    const department = location.departments.get(row.department_id);

    if (!department.designations.has(row.designation_id)) {
      department.designations.set(row.designation_id, {
        designation_id: row.designation_id,
        designation_name: row.designation_name,
        shifts: [],
        // True once any shift of this designation is priced. The screen shows
        // the money columns and the checkpoint row off this flag rather than
        // off a designation name.
        has_rates: false,
        coverage: null,
        ...emptyRollup(),
      });
    }
    const designation = department.designations.get(row.designation_id);

    const approved_headcount = Number(row.approved_headcount) || 0;
    const monthly_rate =
      row.monthly_rate === null || row.monthly_rate === undefined
        ? null
        : Number(row.monthly_rate);
    const monthly_budget = shiftMonthlyBudget(approved_headcount, monthly_rate);

    const shift = {
      staff_budget_id: row.staff_budget_id,
      work_shift_id: row.work_shift_id,
      shift_name: row.shift_name,
      shift_code: row.shift_code,
      in_time: row.in_time,
      out_time: row.out_time,
      // The shift does not run the same hours on every working day, so its
      // contribution to a checkpoint figure is its usual window and the
      // screen says so.
      schedule_varies: Boolean(row.schedule_varies),
      approved_headcount,
      monthly_rate,
      monthly_budget,
    };
    designation.shifts.push(shift);

    if (monthly_rate !== null) designation.has_rates = true;

    foldIntoRollup(designation, shift);
    foldIntoRollup(department, shift);
    foldIntoRollup(location, shift);
  }

  const byName = (key) => (a, b) =>
    String(a[key] || "").localeCompare(String(b[key] || ""));

  return [...locations.values()]
    .map((location) => ({
      ...location,
      departments: [...location.departments.values()]
        .map((department) => ({
          ...department,
          designations: [...department.designations.values()]
            .map((designation) => ({
              ...designation,
              shifts: designation.shifts.sort(
                (a, b) =>
                  (parseTimeToMinutes(a.in_time) === null
                    ? MINUTES_PER_DAY
                    : parseTimeToMinutes(a.in_time)) -
                  (parseTimeToMinutes(b.in_time) === null
                    ? MINUTES_PER_DAY
                    : parseTimeToMinutes(b.in_time))
              ),
              // Computed for every designation, not only the priced ones: it
              // is derived from times the row already carries, and deciding
              // who "deserves" it by name is exactly what this feature avoids.
              coverage: checkpointCoverage(designation.shifts),
              // True when any shift of this designation runs different hours
              // on different working days, so the screen can qualify the
              // checkpoint figures instead of overstating their precision.
              coverage_approximate: designation.shifts.some((s) => s.schedule_varies),
            }))
            .sort(byName("designation_name")),
        }))
        .sort(byName("department_name")),
    }))
    .sort(byName("outlet_name"));
}

module.exports = {
  CHECKPOINTS,
  representativeWindow,
  validateApprovedHeadcount,
  shiftCoversCheckpoint,
  checkpointCoverage,
  shiftMonthlyBudget,
  emptyRollup,
  foldIntoRollup,
  buildBudgetTree,
};
