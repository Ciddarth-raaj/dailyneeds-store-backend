/**
 * LR FOLLOW-UP ACCESS SCOPE - which branches' follow-ups
 * (including manual ones) a caller may see and act on.
 *
 * WHY NOT THE GLOBAL DASHBOARD SCOPE. LR follow-up is a company-wide desk:
 * one person chases every pending purchase for every branch. The generic
 * `dashboard_scope_*` keys answer a different question (which branches'
 * DASHBOARDS a manager sees), and inheriting them made two things wrong at
 * once - the follow-up desk could end up confined to its own store, and
 * granting it company-wide follow-ups meant granting company-wide
 * attendance and every other dashboard too. So the module has its OWN rule
 * and its OWN key, and the dashboard keys neither widen nor narrow it.
 *
 *   administrator (user_type 2)          ALL stores
 *   lr_followup_all_stores               ALL stores (active employee)
 *   otherwise                            OWN store (new_employee.store_id,
 *                                        read live), or NONE without one
 *
 * The feature keys (view_lr_followup, mark_lr_goods_received, ...) decide
 * WHAT someone may do; this decides WHERE. Holding a feature key never
 * widens the location, and the all-stores key alone opens no screen.
 *
 * `null` = every branch; `[id]` = that branch only; NONE refuses.
 */
const { isActiveEmployeeRow } = require("./dashboard_scope");

const LR_ALL_STORES_KEY = "lr_followup_all_stores";

const LR_SCOPE = Object.freeze({ ALL_STORES: "ALL_STORES", OWN_STORE: "OWN_STORE", NONE: "NONE" });

const LR_SCOPE_REASON = Object.freeze({
  ADMIN: "ADMIN",
  ALL_STORES_GRANTED: "ALL_STORES_GRANTED",
  OWN_STORE: "OWN_STORE",
  NO_EMPLOYEE_RECORD: "NO_EMPLOYEE_RECORD",
  EMPLOYEE_INACTIVE: "EMPLOYEE_INACTIVE",
  NO_STORE_ASSIGNED: "NO_STORE_ASSIGNED",
});

/** The pure decision. `employee` is the live Employee Master row, or null. */
function decideLrScope({ isAdmin, hasAllStores, employee }) {
  if (isAdmin) return { kind: LR_SCOPE.ALL_STORES, store_ids: null, reason: LR_SCOPE_REASON.ADMIN };
  // Every non-administrator must be an active employee, whichever scope -
  // a leaver holding the all-stores key must not keep company-wide access.
  if (!employee) return { kind: LR_SCOPE.NONE, store_ids: [], reason: LR_SCOPE_REASON.NO_EMPLOYEE_RECORD };
  if (!isActiveEmployeeRow(employee)) {
    return { kind: LR_SCOPE.NONE, store_ids: [], reason: LR_SCOPE_REASON.EMPLOYEE_INACTIVE };
  }
  if (hasAllStores) {
    return { kind: LR_SCOPE.ALL_STORES, store_ids: null, reason: LR_SCOPE_REASON.ALL_STORES_GRANTED };
  }
  if (employee.store_id === null || employee.store_id === undefined) {
    return { kind: LR_SCOPE.NONE, store_ids: [], reason: LR_SCOPE_REASON.NO_STORE_ASSIGNED };
  }
  return { kind: LR_SCOPE.OWN_STORE, store_ids: [Number(employee.store_id)], reason: LR_SCOPE_REASON.OWN_STORE };
}

const MESSAGE = {
  NO_EMPLOYEE_RECORD: "Your login is not linked to an employee record, so no branch can be resolved.",
  EMPLOYEE_INACTIVE: "Your employee record is inactive.",
  NO_STORE_ASSIGNED:
    "You have no branch assigned. Ask an administrator for 'LR Follow-up: All Stores' or assign your branch in Employee Master.",
};

/**
 * Builds the resolver from the permission middleware and the small
 * employee-store repository the dashboard layer already uses (a read of
 * new_employee.store_id and status - nothing about dashboards).
 */
function createLrScope(permissions, employeeStoreRepo) {
  const resolve = async (req) => {
    const isAdmin = Number(req.decoded && req.decoded.user_type) === Number(permissions.ADMIN_USER_TYPE ?? 2);
    if (isAdmin) return decideLrScope({ isAdmin: true });
    const [hasAllStores, employee] = await Promise.all([
      permissions.has(req, LR_ALL_STORES_KEY),
      req.decoded && req.decoded.employee_id
        ? employeeStoreRepo.getEmployeeStore(req.decoded.employee_id)
        : Promise.resolve(null),
    ]);
    return decideLrScope({ isAdmin: false, hasAllStores, employee });
  };

  /** The store ids for this request, or a ForbiddenError. */
  const storeIds = async (req) => {
    const scope = await resolve(req);
    if (scope.kind === LR_SCOPE.NONE) {
      const err = new Error(MESSAGE[scope.reason] || "No branch scope for LR Follow-up.");
      err.name = "ForbiddenError";
      err.reason = scope.reason;
      throw err;
    }
    return scope.store_ids;
  };

  return { resolve, storeIds };
}

module.exports = { LR_ALL_STORES_KEY, LR_SCOPE, LR_SCOPE_REASON, decideLrScope, createLrScope };
