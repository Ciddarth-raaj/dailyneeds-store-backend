const { parseAllowList, toBoolean, validateIpPolicy } = require("../utils/ip");

/**
 * Columns that must never leave through the token-less outlet reads.
 *
 * `GET /outlet` and `GET /outlet/id` need no token, and a branch's allow-list
 * is not something to hand to anyone who asks. The IP rule has its own
 * permission-gated endpoints.
 */
const IP_FIELDS = ["allowed_ips", "ip_restriction_enabled"];

function stripIpFields(row) {
  if (!row || typeof row !== "object") return row;
  const copy = { ...row };
  for (const field of IP_FIELDS) delete copy[field];
  return copy;
}

/** A repository row with its list parsed and its flag read as a boolean. */
function shapeIpRestriction(row) {
  if (!row) return null;
  return {
    ...row,
    allowed_ips: parseAllowList(row.allowed_ips),
    ip_restriction_enabled: toBoolean(row.ip_restriction_enabled, false),
    employee_count: Number(row.employee_count) || 0,
  };
}

class OutletUsecase {
  constructor(outletRepo, budgetRepo) {
    this.outletRepo = outletRepo;
    this.budgetRepo = budgetRepo;
  }

  get() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.outletRepo.get();
        resolve((data || []).map(stripIpFields));
      } catch (err) {
        reject(err);
      }
    });
  }
  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.outletRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  getOutletById(outlet_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.outletRepo.getOutletById(outlet_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getOutletByOutletId(outlet_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const rows = await this.outletRepo.getOutletByOutletId(outlet_id);
        const budget = await this.budgetRepo.getBudgetByStoreId(outlet_id);

        const data = (rows || []).map(stripIpFields);
        if (data.length > 0) {
          data[0].budget = budget;
        }

        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getOutletByGofrugalId(gofrugal_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const outlet = await this.outletRepo.getOutletByGofrugalId(gofrugal_id);
        resolve(outlet);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateOutletDetails(outlet) {
    return new Promise(async (resolve, reject) => {
      try {
        const outlet_id = outlet.outlet_id;
        const res = await this.outletRepo.updateOutletDetails(
          outlet.outlet_details,
          outlet_id
        );

        if (outlet.budget) {
          await Promise.all(
            outlet.budget
              .filter(
                (item) =>
                  item.count !== undefined && item.designation_id !== undefined
              )
              .map(async (budget) => {
                if (budget.budget_id) {
                  await this.budgetRepo.update({
                    budget: budget.count,
                    budget_id: budget.budget_id,
                    designation_id: budget.designation_id,
                  });
                } else {
                  await this.budgetRepo.create({
                    store_id: outlet_id,
                    designation_name: budget.designation,
                    designation_id: budget.designation_id,
                    budget: budget.count,
                  });
                }
              })
          );
        }

        resolve(res);
      } catch (err) {
        reject(err);
      }
    });
  }
  create(outlet) {
    return new Promise(async (resolve, reject) => {
      try {
        const id = await this.outletRepo.create(outlet.outlet_details);

        if (outlet.budget) {
          await Promise.all(
            outlet.budget.map(async (budget) => {
              await this.budgetRepo.create({
                store_id: id.id,
                designation_name: budget.designation,
                designation_id: budget.designation_id,
                budget: budget.count,
              });
            })
          );
        }
        resolve({ code: 200, msg: "Outlet created successfully" });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Every branch with its IP rule, for the admin screens. */
  async getIpRestrictions() {
    const rows = await this.outletRepo.getIpRestrictions();
    return (rows || []).map(shapeIpRestriction);
  }

  /** One branch's IP rule, or null when there is no such outlet. */
  async getIpRestriction(outlet_id) {
    const row = await this.outletRepo.getIpRestriction(outlet_id);
    return shapeIpRestriction(row);
  }

  /**
   * Replace a branch's IP rule.
   *
   * Switching the rule on with an empty list is refused — it would lock every
   * employee of the branch out of every network — as is a loopback entry
   * (the sign of a proxy that is not forwarding the client address).
   */
  async updateIpRestriction(outlet_id, allowed_ips, enabled) {
    const on = toBoolean(enabled, false);
    const { valid, reason, rules } = validateIpPolicy({
      restricted: on,
      allowedIps: allowed_ips,
    });
    if (!valid) {
      const error = new Error(reason);
      error.name = "ValidationError";
      throw error;
    }

    const value = rules.length === 0 ? null : rules.join(", ");
    const res = await this.outletRepo.updateIpRestriction(outlet_id, value, on);
    if (!res || res.affectedRows === 0) {
      const error = new Error(`No branch with outlet_id ${outlet_id}`);
      error.name = "NotFoundError";
      throw error;
    }

    return {
      code: 200,
      outlet_id: Number(outlet_id),
      allowed_ips: rules,
      ip_restriction_enabled: on,
    };
  }

  bulkCreate(rows) {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await this.outletRepo.bulkCreate(rows);
        const branches = await this.get();
        resolve({
          code: 200,
          message: "Branches bulk insert completed successfully",
          branches: branches,
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}
module.exports = (outletRepo, budgetRepo) => {
  return new OutletUsecase(outletRepo, budgetRepo);
};
