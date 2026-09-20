/**
 * The Staff Budget calculations.
 *
 *   node --test utils/staffBudget.test.js
 *
 * The two assertions that matter most here:
 *
 *   - Total approved headcount and checkpoint headcount are DIFFERENT
 *     numbers, and a position on a long shift is counted once in the total
 *     while appearing at more than one checkpoint.
 *   - "No rate configured" is never reported as zero rupees.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CHECKPOINTS,
  representativeWindow,
  validateApprovedHeadcount,
  shiftCoversCheckpoint,
  checkpointCoverage,
  shiftMonthlyBudget,
  buildBudgetTree,
} = require("../utils/staffBudget");

/**
 * The five shifts the business runs, as a budget row carries them: a
 * `work_shift` id plus the working-day window resolved from
 * `work_shift_weekly_schedule`.
 */
const SHIFTS = {
  nineToSix: { work_shift_id: 11, shift_name: "9 AM - 6 PM", in_time: "09:00:00", out_time: "18:00:00" },
  nineToNine: { work_shift_id: 12, shift_name: "9 AM - 9 PM", in_time: "09:00:00", out_time: "21:00:00" },
  tenToTen: { work_shift_id: 13, shift_name: "10 AM - 10 PM", in_time: "10:00:00", out_time: "22:00:00" },
  twoToTen: { work_shift_id: 14, shift_name: "2 PM - 10 PM", in_time: "14:00:00", out_time: "22:00:00" },
  sixToTen: { work_shift_id: 15, shift_name: "6 PM - 10 PM", in_time: "18:00:00", out_time: "22:00:00" },
};

/** A `work_shift_weekly_schedule` row. */
const day = (day_of_week, overrides = {}) => ({
  day_of_week,
  is_working_day: 1,
  in_time: "14:00:00",
  out_time: "22:00:00",
  ...overrides,
});

describe("the work shift's window", () => {
  it("reads the working-day window, ignoring rest days", () => {
    const schedule = [
      day(0, { is_working_day: 0, in_time: null, out_time: null }),
      day(1),
      day(2),
      day(3),
      day(4),
      day(5),
      day(6),
    ];
    assert.deepEqual(representativeWindow(schedule), {
      in_time: "14:00:00",
      out_time: "22:00:00",
      varies: false,
    });
  });

  it("takes the window that occurs on the most working days, and says it varies", () => {
    const schedule = [
      day(1),
      day(2),
      day(3),
      day(4),
      day(5, { in_time: "10:00:00", out_time: "22:00:00" }),
    ];
    const window = representativeWindow(schedule);
    assert.equal(window.in_time, "14:00:00");
    assert.equal(window.varies, true);
  });

  it("reports no window for a shift with no working day", () => {
    assert.deepEqual(
      representativeWindow([day(0, { is_working_day: 0, in_time: null, out_time: null })]),
      { in_time: null, out_time: null, varies: false }
    );
    assert.deepEqual(representativeWindow([]), {
      in_time: null,
      out_time: null,
      varies: false,
    });
  });
});

describe("approved headcount validation", () => {
  it("accepts zero and positive whole numbers, including numeric strings", () => {
    assert.equal(validateApprovedHeadcount(0), 0);
    assert.equal(validateApprovedHeadcount(4), 4);
    assert.equal(validateApprovedHeadcount("7"), 7);
  });

  it("refuses a negative, a fraction, a blank and nonsense", () => {
    for (const bad of [-1, 3.5, "", null, undefined, "abc", {}]) {
      assert.throws(() => validateApprovedHeadcount(bad));
    }
  });
});

describe("checkpoint coverage", () => {
  it("counts both ends of a shift as covered", () => {
    assert.equal(shiftCoversCheckpoint(SHIFTS.nineToSix, "09:00"), true);
    assert.equal(shiftCoversCheckpoint(SHIFTS.tenToTen, "22:00"), true);
  });

  it("derives coverage from the times, not from the shift name", () => {
    const renamed = { ...SHIFTS.tenToTen, shift_name: "Afternoon crew" };
    assert.equal(shiftCoversCheckpoint(renamed, "18:00"), true);
    assert.equal(shiftCoversCheckpoint(renamed, "09:00"), false);
  });

  it("handles a shift that runs past midnight", () => {
    const overnight = { in_time: "18:00", out_time: "02:00" };
    assert.equal(shiftCoversCheckpoint(overnight, "22:00"), true);
    assert.equal(shiftCoversCheckpoint(overnight, "01:00"), true);
    assert.equal(shiftCoversCheckpoint(overnight, "09:00"), false);
  });

  it("treats an unknown time as no coverage rather than as coverage", () => {
    assert.equal(shiftCoversCheckpoint({ in_time: null, out_time: "22:00" }, "18:00"), false);
    assert.equal(shiftCoversCheckpoint({ in_time: "oops", out_time: "22:00" }, "18:00"), false);
  });

  it("reports simultaneous staffing, which is not the total", () => {
    // The worked example: 9-6 x4, 9-9 x3, 10-10 x2, 2-10 x5, 6-10 x2.
    const rows = [
      { ...SHIFTS.nineToSix, approved_headcount: 4 },
      { ...SHIFTS.nineToNine, approved_headcount: 3 },
      { ...SHIFTS.tenToTen, approved_headcount: 2 },
      { ...SHIFTS.twoToTen, approved_headcount: 5 },
      { ...SHIFTS.sixToTen, approved_headcount: 2 },
    ];
    const total = rows.reduce((s, r) => s + r.approved_headcount, 0);
    const coverage = checkpointCoverage(rows);

    assert.equal(total, 16);
    // 09:00 - only the two shifts that have started.
    assert.equal(coverage.opening, 7);
    // 18:00 - everything except 9-6, which ends exactly then and so counts.
    assert.equal(coverage.peak, 16);
    // 22:00 - the three shifts still running at close. 9-9 has already
    // ended at 21:00, which is why Closing is not simply "everyone late".
    assert.equal(coverage.closing, 9);

    // The same position is at Opening AND Peak, and is one position overall.
    assert.ok(coverage.opening + coverage.peak + coverage.closing !== total);
  });

  it("names the three checkpoints the business asked for", () => {
    assert.deepEqual(
      CHECKPOINTS.map((c) => [c.key, c.time]),
      [["opening", "09:00"], ["peak", "18:00"], ["closing", "22:00"]]
    );
  });
});

describe("money", () => {
  it("multiplies approved positions by the monthly rate", () => {
    assert.equal(shiftMonthlyBudget(4, 11000), 44000);
    assert.equal(shiftMonthlyBudget(0, 14500), 0);
  });

  it("reports an unpriced shift as null, never as zero rupees", () => {
    assert.equal(shiftMonthlyBudget(4, null), null);
    assert.equal(shiftMonthlyBudget(4, undefined), null);
  });
});

/** The screen's worked example, as the repository would hand it over. */
function exampleRows() {
  const base = {
    outlet_id: 3,
    outlet_name: "ECR",
    department_id: 1,
    department_name: "Sales",
    designation_id: 21,
    designation_name: "Customer Service Associate",
  };
  return [
    { ...base, staff_budget_id: 1, ...SHIFTS.nineToSix, approved_headcount: 4, monthly_rate: 11000 },
    { ...base, staff_budget_id: 2, ...SHIFTS.nineToNine, approved_headcount: 3, monthly_rate: 14000 },
    { ...base, staff_budget_id: 3, ...SHIFTS.tenToTen, approved_headcount: 2, monthly_rate: 14500 },
    { ...base, staff_budget_id: 4, ...SHIFTS.twoToTen, approved_headcount: 5, monthly_rate: 11500 },
    { ...base, staff_budget_id: 5, ...SHIFTS.sixToTen, approved_headcount: 2, monthly_rate: 5000 },
    // Same store and department, a designation with no rates configured.
    {
      ...base,
      staff_budget_id: 6,
      designation_id: 22,
      designation_name: "Store Keeper",
      ...SHIFTS.nineToSix,
      approved_headcount: 2,
      monthly_rate: null,
    },
  ];
}

describe("the budget tree", () => {
  const tree = buildBudgetTree(exampleRows());
  const location = tree[0];
  const department = location.departments[0];
  const [csa, storeKeeper] = department.designations;

  it("keeps the same four levels for every location", () => {
    assert.equal(tree.length, 1);
    assert.equal(location.outlet_name, "ECR");
    assert.equal(department.department_name, "Sales");
    assert.equal(csa.designation_name, "Customer Service Associate");
    assert.equal(csa.shifts.length, 5);
  });

  it("orders shifts by their In time", () => {
    assert.deepEqual(
      csa.shifts.map((s) => s.work_shift_id),
      [11, 12, 13, 14, 15]
    );
  });

  it("totals headcount at designation, department and location", () => {
    assert.equal(csa.total_headcount, 16);
    assert.equal(storeKeeper.total_headcount, 2);
    assert.equal(department.total_headcount, 18);
    assert.equal(location.total_headcount, 18);
  });

  it("totals the priced budget from the shift budgets", () => {
    // 44000 + 42000 + 29000 + 57500 + 10000
    assert.equal(csa.priced_monthly_budget, 182500);
    assert.equal(csa.fully_priced, true);
    assert.equal(csa.unpriced_headcount, 0);
  });

  it("leaves an unpriced designation with headcount and no money", () => {
    assert.equal(storeKeeper.has_rates, false);
    assert.equal(storeKeeper.priced_monthly_budget, null);
    assert.equal(storeKeeper.priced_headcount, 0);
    assert.equal(storeKeeper.unpriced_headcount, 2);
    assert.equal(storeKeeper.fully_priced, false);
    assert.equal(storeKeeper.shifts[0].monthly_budget, null);
  });

  /* ------------------------------------------------------------------------
   * PARTIAL PRICING. The regression these guard: a department or location
   * holding both priced and unpriced designations must never report the
   * priced part as though it were the whole staff budget.
   * --------------------------------------------------------------------- */

  it("never calls a partial money figure complete at department level", () => {
    // Sales holds CSA (priced, 16) and Store Keeper (unpriced, 2).
    assert.equal(department.total_headcount, 18);
    assert.equal(department.priced_headcount, 16);
    assert.equal(department.unpriced_headcount, 2);
    assert.equal(department.priced_monthly_budget, 182500);
    assert.equal(
      department.fully_priced,
      false,
      "one unpriced approved position makes the money figure partial"
    );
  });

  it("never calls a partial money figure complete at location level", () => {
    assert.equal(location.total_headcount, 18);
    assert.equal(location.priced_headcount, 16);
    assert.equal(location.unpriced_headcount, 2);
    assert.equal(location.priced_monthly_budget, 182500);
    assert.equal(location.fully_priced, false);
  });

  it("marks a level complete only when every approved position is priced", () => {
    const pricedOnly = buildBudgetTree(
      exampleRows().filter((row) => row.designation_id === 21)
    )[0];
    assert.equal(pricedOnly.fully_priced, true);
    assert.equal(pricedOnly.unpriced_headcount, 0);
    assert.equal(pricedOnly.priced_monthly_budget, 182500);
  });

  it("reports no money figure at all for a level with nothing priced", () => {
    const unpricedOnly = buildBudgetTree(
      exampleRows().filter((row) => row.designation_id === 22)
    )[0];
    assert.equal(
      unpricedOnly.priced_monthly_budget,
      null,
      "no rate configured is not zero rupees"
    );
    assert.equal(unpricedOnly.fully_priced, false);
    assert.equal(unpricedOnly.total_headcount, 2);
  });

  it("an unpriced shift with NO approved position does not make a level partial", () => {
    // Nothing is unknown about the cost of a position that does not exist.
    const rows = exampleRows().map((row) =>
      row.designation_id === 22 ? { ...row, approved_headcount: 0 } : row
    );
    const level = buildBudgetTree(rows)[0];
    assert.equal(level.fully_priced, true);
    assert.equal(level.unpriced_headcount, 0);
    assert.equal(level.total_headcount, 16);
  });

  it("carries checkpoint coverage alongside, not instead of, the total", () => {
    assert.equal(csa.total_headcount, 16);
    assert.deepEqual(csa.coverage, { opening: 7, peak: 16, closing: 9 });
  });

  it("gives Warehouse the same shape, department and all", () => {
    const warehouse = buildBudgetTree([
      {
        staff_budget_id: 9,
        outlet_id: 2,
        outlet_name: "Daily Needs-Warehouse",
        department_id: 5,
        department_name: "Inward",
        designation_id: 31,
        designation_name: "Loader",
        ...SHIFTS.nineToSix,
        approved_headcount: 6,
        monthly_rate: null,
      },
    ])[0];

    assert.equal(warehouse.departments.length, 1);
    assert.equal(warehouse.departments[0].department_name, "Inward");
    // Unpriced, so it reports headcount and no budget - not a zero budget.
    assert.equal(warehouse.priced_monthly_budget, null);
    assert.equal(warehouse.unpriced_headcount, 6);
    assert.equal(warehouse.fully_priced, false);
    assert.equal(warehouse.departments[0].designations[0].shifts.length, 1);
    assert.equal(warehouse.total_headcount, 6);
  });
});
