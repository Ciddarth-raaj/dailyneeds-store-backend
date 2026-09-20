const {
  buildBudgetTree,
  validateApprovedHeadcount,
  CHECKPOINTS,
} = require("../utils/staffBudget");

/**
 * Shaped so utils/http.js `respondError` answers 400 with the detail, the way
 * a Joi failure already does.
 */
function validationError(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  const err = new Error(list.join("; "));
  err.name = "ValidationError";
  err.details = list;
  return err;
}

/**
 * The Staff Budget Master.
 *
 * WHAT THIS LAYER IS FOR: validating that a combination is made of real,
 * active master records, and turning flat rows into the hierarchy the screen
 * draws. The arithmetic itself lives in utils/staffBudget.js so it can be
 * tested without a database.
 *
 * THE SHIFT DIMENSION IS `work_shift`, the master the attendance engine
 * resolves against - not the legacy `shift_master`.
 *
 * THERE IS NO DEPARTMENT <-> DESIGNATION MAPPING IN THIS SCHEMA and this
 * feature does not invent one. Each of the four ids is checked on its own -
 * it exists, and it is active - and the budget row itself is the record that
 * management approved that combination. If a mapping master is ever added,
 * the one place to enforce it is `validateCombination` below.
 */
class StaffBudgetUsecase {
  constructor(staffBudgetRepo) {
    this.staffBudgetRepo = staffBudgetRepo;
  }

  /**
   * The whole screen: the nested hierarchy plus the totals at every level.
   *
   * Totals are computed here rather than in SQL so that "priced" and "not
   * priced" stay distinguishable all the way up - a designation with no
   * configured rate contributes headcount and contributes NOTHING to the
   * money column, rather than contributing zero rupees.
   */
  async getBudget({ outlet_id } = {}) {
    const rows = await this.staffBudgetRepo.getBudgetRows({ outlet_id });
    return {
      checkpoints: CHECKPOINTS,
      locations: buildBudgetTree(rows),
    };
  }

  /** The active master records the pickers offer, names and ids together. */
  async getMasters() {
    return this.staffBudgetRepo.getMasters();
  }

  /**
   * Each of the four ids must name a master record that exists and is active.
   *
   * Reports every problem at once, naming the master, because a form with two
   * stale selections should say so once rather than over two round trips.
   */
  async validateCombination(combination) {
    const checks = await this.staffBudgetRepo.checkMasters(combination);
    const errors = [];
    const labels = {
      outlet: "location",
      department: "department",
      designation: "designation",
      shift: "shift",
    };

    for (const [key, label] of Object.entries(labels)) {
      const check = checks[key];
      if (!check.found) errors.push(`The selected ${label} does not exist`);
      else if (!check.active) errors.push(`The selected ${label} is not active`);
    }

    if (errors.length > 0) throw validationError(errors);
    return true;
  }

  /**
   * Set the approved headcount for one combination.
   *
   * Validation order is deliberate: the headcount is checked FIRST, so a
   * malformed number is refused without four master lookups, and the
   * combination is checked before anything is written.
   */
  async saveBudget(input, actorId) {
    const approved_headcount = validateApprovedHeadcount(input.approved_headcount);

    const combination = {
      outlet_id: Number(input.outlet_id),
      department_id: Number(input.department_id),
      designation_id: Number(input.designation_id),
      work_shift_id: Number(input.work_shift_id),
    };
    await this.validateCombination(combination);

    const result = await this.staffBudgetRepo.upsertBudget(
      { ...combination, approved_headcount },
      actorId
    );

    return {
      code: 200,
      staff_budget_id: result.staff_budget_id,
      created: result.created,
      approved_headcount,
    };
  }

  /**
   * Save a whole designation's shift grid in one call.
   *
   * The screen edits a designation's shifts together, so they are validated
   * together: NOTHING is written unless every row in the grid is valid. A
   * grid saved half-way is a plan nobody approved.
   *
   * The rows themselves are then written one transaction each, by
   * `upsertBudget`, so a row that collides with a concurrent edit fails
   * alone rather than taking the grid with it. That is the deliberate
   * trade: all-or-nothing on VALIDATION, row-at-a-time on WRITE.
   */
  async saveBudgetBulk(rows, actorId) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw validationError("At least one shift row is required");
    }

    const prepared = [];
    const errors = [];

    for (const [index, row] of rows.entries()) {
      const where = `row ${index + 1}`;
      let approved_headcount;
      try {
        approved_headcount = validateApprovedHeadcount(row.approved_headcount);
      } catch (err) {
        errors.push(`${where}: ${err.message}`);
        continue;
      }

      const combination = {
        outlet_id: Number(row.outlet_id),
        department_id: Number(row.department_id),
        designation_id: Number(row.designation_id),
        work_shift_id: Number(row.work_shift_id),
      };

      try {
        await this.validateCombination(combination);
      } catch (err) {
        errors.push(`${where}: ${err.message}`);
        continue;
      }

      prepared.push({ ...combination, approved_headcount });
    }

    // The same combination twice in one payload would have the second write
    // silently overwrite the first, so it is refused rather than resolved.
    const seen = new Set();
    for (const row of prepared) {
      const key = [row.outlet_id, row.department_id, row.designation_id, row.work_shift_id].join(":");
      if (seen.has(key)) {
        errors.push("The same location/department/designation/shift appears twice in this save");
        break;
      }
      seen.add(key);
    }

    if (errors.length > 0) throw validationError(errors);

    const saved = [];
    for (const row of prepared) {
      saved.push(await this.staffBudgetRepo.upsertBudget(row, actorId));
    }

    return { code: 200, saved: saved.length, rows: saved };
  }

  /** Take a combination out of the plan, keeping its row and its history. */
  async removeBudget(staff_budget_id, actorId) {
    const existing = await this.staffBudgetRepo.getBudgetById(staff_budget_id);
    if (!existing) return { code: 404, msg: "Staff budget row not found" };

    const removed = await this.staffBudgetRepo.deactivateBudget(staff_budget_id, actorId);
    if (!removed) return { code: 404, msg: "Staff budget row is already removed" };

    return { code: 200, staff_budget_id: Number(staff_budget_id) };
  }

  /** What an approved headcount used to be. */
  async getHistory(staff_budget_id) {
    const existing = await this.staffBudgetRepo.getBudgetById(staff_budget_id);
    if (!existing) return null;
    return this.staffBudgetRepo.getHistory(staff_budget_id);
  }

  /** Every configured monthly rate. */
  async getRates() {
    return this.staffBudgetRepo.getRates();
  }

  /**
   * Configure one monthly rate, for a designation and work shift a person
   * picked on the rate screen.
   *
   * THE ONLY WAY A RATE IS EVER WRITTEN. There is deliberately no action that
   * finds a designation by name, or a shift by its timings, and prices it: a
   * production write that decides for itself which master record the money
   * belongs to is the failure this feature must not have. The screen shows
   * the live masters by name, a person chooses, and what is stored is the ids
   * they chose.
   */
  async saveRate(input, actorId) {
    const monthly_rate = Number(input.monthly_rate);
    if (!Number.isFinite(monthly_rate) || monthly_rate < 0) {
      throw validationError("monthly_rate must be 0 or more");
    }

    const designation_id = Number(input.designation_id);
    const work_shift_id = Number(input.work_shift_id);

    // Only two of the four masters are involved in a rate: a rate is the same
    // at every location and in every department, which is why the rate table
    // is keyed by designation and shift alone.
    const checks = await this.staffBudgetRepo.checkMasters({
      outlet_id: null,
      department_id: null,
      designation_id,
      work_shift_id,
    });
    const errors = [];
    if (!checks.designation.found) errors.push("The selected designation does not exist");
    else if (!checks.designation.active) errors.push("The selected designation is not active");
    if (!checks.shift.found) errors.push("The selected shift does not exist");
    else if (!checks.shift.active) errors.push("The selected shift is not active");
    if (errors.length > 0) throw validationError(errors);

    const result = await this.staffBudgetRepo.upsertRates(
      [{ designation_id, work_shift_id, monthly_rate }],
      actorId
    );
    return { code: 200, ...result };
  }

}

module.exports = (staffBudgetRepo) => {
  return new StaffBudgetUsecase(staffBudgetRepo);
};
