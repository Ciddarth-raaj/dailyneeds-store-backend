const jwt = require("../services/jwt");
const authConfig = require("../config/auth");

const unProtectedRoutes = {
  "/user": {
    methods: { post: true },
  },
  "/user/login": {
    methods: { get: true },
  },

  //department
  "/department": {
    methods: { get: true },
  },
  "/department/create": {
    methods: { post: true },
  },
  "/department/department_id": {
    methods: { get: true },
  },
  "/department/update-department": {
    methods: { post: true },
  },
  "/department/update-status": {
    methods: { post: true },
  },
  "/department/imageupload": {
    methods: { post: true },
  },
  "/department/product-department": {
    methods: { get: true },
  },
  "/department/update-prodstatus": {
    methods: { post: true },
  },

  //indents
  "/indent": {
    methods: { get: true },
  },
  "/indent/indentcount": {
    methods: { get: true },
  },
  "/indent/create": {
    methods: { post: true },
  },
  "/indent/despatch": {
    methods: { get: true },
  },
  "/indent/sent/store_id": {
    methods: { get: true },
  },
  "/indent/from/store_id": {
    methods: { get: true },
  },

  //despatch
  "/despatch/create": {
    methods: { post: true },
  },
  "/despatch": {
    methods: { get: true },
  },
  "/despatch/store_id": {
    methods: { get: true },
  },
  "/despatch/despatch_id": {
    methods: { get: true },
  },

  //categories
  "/category": {
    methods: { get: true },
  },
  "/category/catcount": {
    methods: { get: true },
  },
  "/category/imageupload": {
    methods: { post: true },
  },

  //subcategories
  "/subcategory": {
    methods: { get: true },
  },
  "/subcategory/subcatcount": {
    methods: { get: true },
  },
  "/subcategory/imageupload": {
    methods: { post: true },
  },

  //designation
  "/designation": {
    methods: { get: true },
  },
  "/designation/create": {
    methods: { post: true },
  },
  "/designation/update-designation": {
    methods: { post: true },
  },
  "/designation/designation_id": {
    methods: { get: true },
  },
  "/designation/update-status": {
    methods: { post: true },
  },
  "/designation/count": {
    methods: { get: true },
  },
  "/designation/budget": {
    methods: { get: true },
  },
  // "/designation/permissions": {
  //   methods: { get: true }
  // },

  //employee
  "/employee": {
    methods: { post: true },
  },
  "/employee/employees": {
    methods: { get: true },
  },
  "/employee/updatedata": {
    methods: { post: true },
  },
  "/employee/employee_id": {
    methods: { get: true },
  },
  "/employee/resignedemp": {
    methods: { get: true },
  },
  "/employee/newjoiner": {
    methods: { get: true },
  },
  "/employee/headcount": {
    methods: { get: true },
  },
  "/employee/birthday": {
    methods: { get: true },
  },
  "/employee/anniversary": {
    methods: { get: true },
  },
  "/employee/bank": {
    methods: { get: true },
  },
  "/employee/familydet": {
    methods: { get: true },
  },
  "/employee/update-status": {
    methods: { post: true },
  },
  "/employee/store_id": {
    methods: { get: true },
  },
  "/employee/newjoinee": {
    methods: { get: true },
  },
  "/employee/filter": {
    methods: { get: true },
  },

  //salary
  "/salary": {
    methods: { get: true },
  },
  "/salary/create": {
    methods: { post: true },
  },
  "/salary/update-payment": {
    methods: { post: true },
  },
  "/salary/update-status": {
    methods: { post: true },
  },
  "/salary/payment_id": {
    methods: { get: true },
  },
  "/salary/update-paidstatus": {
    methods: { post: true },
  },

  //resignation
  "/resignation": {
    methods: { get: true },
  },
  "/resignation/create": {
    methods: { post: true },
  },
  "/resignation/employee_name": {
    methods: { get: true },
  },
  "/resignation/update-resignation": {
    methods: { post: true },
  },
  "/resignation/resignation_id": {
    methods: { post: true },
  },
  "/resignation/get/resignation_id": {
    methods: { get: true },
  },

  //product
  "/product": {
    methods: { get: true },
  },
  "/product/product_id": {
    methods: { get: true },
  },
  "/product/getById": {
    methods: { get: true },
  },
  "/product/prodcount": {
    methods: { get: true },
  },
  "/product/filter": {
    methods: { get: true },
  },
  "/product/all": {
    methods: { get: true },
  },

  //shift
  "/shift": {
    methods: { get: true },
  },
  "/shift/shift_id": {
    methods: { get: true },
  },
  "/shift/update-shift": {
    methods: { post: true },
  },
  "/shift/create": {
    methods: { post: true },
  },
  "/shift/update-status": {
    methods: { post: true },
  },

  //image
  "/image/product_id": {
    methods: { get: true },
  },

  //company
  "/company": {
    methods: { post: true },
  },
  "/company/update-status": {
    methods: { post: true },
  },
  "/company/company_id": {
    methods: { get: true },
  },

  //assets
  "/asset": {
    methods: { post: true },
  },

  //document
  "/document/employee_id": {
    methods: { get: true },
  },
  "/document/adhaar": {
    methods: { get: true },
  },
  "/document/update-status": {
    methods: { post: true },
  },
  "/document/all": {
    methods: { get: true },
  },
  "/document/document_id": {
    methods: { get: true },
  },
  "/document/update-document": {
    methods: { post: true },
  },
  "/document/withoutadhaar": {
    methods: { get: true },
  },

  //store
  "/store": {
    methods: { get: true },
  },
  "/store/store_id": {
    methods: { get: true },
  },

  //Materialtype
  "/materialtype": {
    methods: { get: true },
  },
  "/materialtype/update-status": {
    methods: { post: true },
  },
  "/materialtype/type_id": {
    methods: { get: true },
  },
  "/materialtype/create": {
    methods: { post: true },
  },
  "/materialtype/type": {
    methods: { get: true },
  },
  "/materialtype/size": {
    methods: { get: true },
  },
  "/materialtype/typecount": {
    methods: { get: true },
  },
  "/materialtype/update-materialtype": {
    methods: { post: true },
  },

  //Materialsize
  "/materialsize": {
    methods: { get: true },
  },
  "/materialsize/update-status": {
    methods: { post: true },
  },
  "/materialsize/material_id": {
    methods: { get: true },
  },
  "/materialsize/create": {
    methods: { post: true },
  },
  "/materialsize/update-materialsize": {
    methods: { post: true },
  },
  "/materialsize/type": {
    methods: { get: true },
  },
  "/materialsize/size": {
    methods: { get: true },
  },
  "/materialsize/sizecount": {
    methods: { get: true },
  },
  "/materialsize/size_id": {
    methods: { get: true },
  },

  //outlet
  "/outlet": {
    methods: { get: true },
  },
  "/outlet/update-outlet": {
    methods: { post: true },
  },
  "/outlet/create": {
    methods: { post: true },
  },
  "/outlet/update-status": {
    methods: { post: true },
  },
  "/outlet/outlet_id": {
    methods: { get: true },
  },
  "/outlet/id": {
    methods: { get: true },
  },

  //brand
  "/brand": {
    methods: { get: true },
  },
  "/brand/brandcount": {
    methods: { get: true },
  },

  //vechicle
  "/vehicle": {
    methods: { get: true },
  },
  "/vehicle/vehicledet": {
    methods: { get: true },
  },
  "/vehicle/vehiclecount": {
    methods: { get: true },
  },
  "/vehicle/create": {
    methods: { post: true },
  },
  "/vehicle/update-vehicle": {
    methods: { post: true },
  },
  "/vehicle/vehicle_id": {
    methods: { get: true },
  },

  //budget
  "/budget/id": {
    methods: { get: true },
  },
  "/budget/create": {
    methods: { post: true },
  },
  "/budget/store_id": {
    methods: { get: true },
  },
  "/budget/budget_id": {
    methods: { get: true },
  },
  "/budget/storedet": {
    methods: { get: true },
  },

  //issue
  "/issue/create": {
    methods: { post: true },
  },
  "/issue": {
    methods: { get: true },
  },
  "/issue/store_id": {
    methods: { get: true },
  },
  "/issue/from/store_id": {
    methods: { get: true },
  },

  //family
  "/family": {
    methods: { get: true },
  },
  "/family/create": {
    methods: { post: true },
  },
  "/family/family_id": {
    methods: { get: true },
  },
  "/family/update-family": {
    methods: { post: true },
  },
  "/family/employee_name": {
    methods: { get: true },
  },

  //user
  "/user/login": { methods: { post: true } },
  // Stage 0A: redeeming a setup/reset token happens before any session exists.
  "/user/setup-password": { methods: { post: true } },
  // Password reset: the caller has forgotten their password, so by
  // definition they cannot present a token. A code delivered to the
  // account's linked Telegram chat stands in for one.
  "/user/forgot-password": { methods: { post: true } },
  "/user/reset-password": { methods: { post: true } },
  // "/tally/card-to-bank": { methods: { get: true } },
  // "/tally/sales-entry": { methods: { get: true } },
  // "/tally/expenses": { methods: { get: true } },
  // "/tally/purchase": { methods: { get: true } },
  // "/tally/debit-note": { methods: { get: true } },
  "/purchase-tally": { methods: { post: true } },
  "/purchase": { methods: { post: true } },
  // "/debit-note-tally": { methods: { post: true } },
  "/gofrugal-synker/sync": { methods: { post: true } },
  "/gofrugal-synker/table": { methods: { delete: true } },
};

/**
 * Routes a token carrying `pwc` (must change password) may still reach.
 * Everything else is refused with PASSWORD_CHANGE_REQUIRED until the
 * password is changed (Deployment B, AUTH_ENFORCE_PASSWORD_CHANGE).
 */
const passwordChangeAllowed = {
  "/user/change-password": { post: true },
  "/user/logout": { post: true },
  "/user/my-ip": { get: true },
  "/employee/get-details": { get: true },
  "/designation/permissions": { get: true },
};

const deny = (res, code, msg, extra = {}) => {
  // Body-level codes with HTTP 200 is the convention util/api.js relies on
  // for its redirect-to-login; kept for the 403 case, real status otherwise.
  if (code === 403) {
    res.json({ code: 403, msg, ...extra });
  } else {
    res.status(code).json({ code, msg, ...extra });
  }
  res.end();
};

/**
 * Build the auth middleware.
 *
 * `deps.userUsecase` enables the per-request session check (C4): a token
 * issued before the account's token_valid_from is refused, and a disabled
 * account's token stops working within the cache window rather than at
 * expiry. Without deps the middleware behaves as it did before Stage 0A
 * apart from the identity shape on `req.auth`.
 */
const isPositiveInt = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Turn verified claims into { userId, employeeId, isSystemAccount, legacy }
 * or null when the token does not fit either shape exactly.
 */
function resolveIdentity(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  const ver = decoded.auth_ver;

  if (ver === undefined) {
    // Legacy shape, strictly.
    if (decoded.sub !== undefined) return null;
    if (decoded.sys !== undefined || decoded.pwc !== undefined) return null;
    if (!isPositiveInt(decoded.id)) return null;
    if (!isPositiveInt(decoded.employee_id)) return null;
    return { userId: decoded.id, employeeId: decoded.employee_id, isSystemAccount: false, legacy: true };
  }

  if (ver === 2) {
    if (typeof decoded.sub !== "string" || !/^[1-9][0-9]{0,11}$/.test(decoded.sub)) return null;
    const userId = Number(decoded.sub);
    if (!isPositiveInt(userId)) return null;
    // `id` is still written for old readers; it must agree with sub.
    if (decoded.id !== undefined && decoded.id !== userId) return null;
    const isSystemAccount = decoded.sys === true;
    if (isSystemAccount) {
      if (decoded.employee_id !== undefined && decoded.employee_id !== null) return null;
      return { userId, employeeId: null, isSystemAccount: true, legacy: false };
    }
    if (decoded.employee_id === undefined || decoded.employee_id === null) {
      return { userId, employeeId: null, isSystemAccount: false, legacy: false };
    }
    if (!isPositiveInt(decoded.employee_id)) return null;
    return { userId, employeeId: decoded.employee_id, isSystemAccount: false, legacy: false };
  }

  // 1, 3, "2", null, objects - anything else is malformed.
  return null;
}

/** Session-state row for a non-system account: the employee must exist and be active. */
function employeeActive(state) {
  if (Number(state.is_system_account) === 1) return true;
  if (state.employee_id === null || state.employee_id === undefined) return false;
  return Number(state.employee_status) === 1;
}

function create(deps = {}) {
  const config = deps.config || authConfig;
  const userUsecase = deps.userUsecase || null;
  const cache = new Map();
  const ttl = config.login.tokenValidFromCacheMs;

  const loadSession = async (userId) => {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < ttl) return hit.state;
    const state = await userUsecase.getSessionState(userId);
    cache.set(userId, { state, at: Date.now() });
    return state;
  };

  const invalidate = (userId) => {
    if (userId === undefined) cache.clear();
    else cache.delete(userId);
  };

  const middleware = async (req, res, next) => {
    if (
      unProtectedRoutes[req.path] &&
      unProtectedRoutes[req.path]["methods"][req.method.toLowerCase()]
    ) {
      next();
      return;
    }

    const token = req.headers["x-access-token"];
    if (token === undefined) return deny(res, 403, "Access Denied");

    let decoded;
    try {
      decoded = await jwt.verify(token);
    } catch (err) {
      return deny(res, 403, "Access Denied");
    }

    // ------------------------------------------------------------------
    // Identity resolution is VERSIONED (safety correction pass, item 1).
    //
    //   auth_ver 2  (issued by Stage 0A code)
    //     sub          = user.user_id            -> the account
    //     employee_id  = new_employee.employee_id (employee accounts only)
    //     sys: true    = system / break-glass account
    //
    //   no auth_ver   (issued by the code deployed before Stage 0A)
    //     id           = user.user_id            -> the account
    //     employee_id  = new_employee.employee_id
    //     no sub, no kid, no sys
    //
    // A legacy token is resolved ONLY through its `id` and `employee_id`
    // claims, both of which must be present and numeric, and it is refused
    // outright if it carries `sub`, `sys` or `pwc` - claims the old code
    // never wrote. It can therefore never name a system account, whose
    // rows have employee_id NULL and did not exist when the token was
    // issued. When a user usecase is wired in, the legacy account is also
    // looked up and refused unless it is a genuine, non-system,
    // employee-linked row (not relying on NULL failing to match).
    //
    // Any other auth_ver value is malformed and refused.
    // ------------------------------------------------------------------
    const identity = resolveIdentity(decoded);
    if (!identity) return deny(res, 403, "Access Denied");
    const { userId, employeeId, isSystemAccount, legacy } = identity;

    req.auth = Object.freeze({
      userId,
      employeeId,
      userType: decoded.user_type,
      designationId: decoded.designation_id === undefined ? null : decoded.designation_id,
      storeId: decoded.store_id === undefined ? null : decoded.store_id,
      isSystemAccount,
      mustChangePassword: !legacy && decoded.pwc === true,
      issuedAt: decoded.iat,
      authVersion: legacy ? 1 : 2,
    });

    // Backward-compatible shape. `employee_id` is null (never undefined,
    // never a fake) for a system account.
    req.decoded = {
      id: userId,
      store_id: req.auth.storeId,
      user_type: decoded.user_type,
      designation_id: req.auth.designationId,
      employee_id: employeeId,
      is_system_account: isSystemAccount,
    };

    // A legacy token must resolve to a genuine employee-linked account and
    // never to a system account. With the usecase available this is
    // checked against the database, cached briefly, failing closed.
    if (legacy && userUsecase) {
      try {
        const state = await loadSession(userId);
        if (!state || Number(state.status) !== 1) return deny(res, 403, "Access Denied");
        if (Number(state.is_system_account) === 1) return deny(res, 403, "Access Denied");
        if (state.employee_id === null || state.employee_id === undefined) {
          return deny(res, 403, "Access Denied");
        }
        if (Number(state.employee_id) !== employeeId) return deny(res, 403, "Access Denied");
        if (config.login.employeeStatusCheck && !employeeActive(state)) {
          return deny(res, 403, "Access Denied", { error: "EMPLOYEE_INACTIVE" });
        }
      } catch (err) {
        return deny(res, 500, "An error occurred !");
      }
    }

    // Gate 14: an employee who has left (new_employee.status <> 1) keeps a
    // valid token and a user row with status 1 - the login query refuses
    // them, but nothing refused their existing session. Now every request
    // from an employee-linked account is checked against the employee's
    // status (cached for tokenValidFromCacheMs). System accounts have no
    // employee and are judged by user.status alone. Reactivating the
    // employee reinstates access with no change to the user row.
    if (!legacy && userUsecase && config.login.employeeStatusCheck && !isSystemAccount) {
      try {
        const state = await loadSession(userId);
        if (!state || Number(state.status) !== 1) return deny(res, 403, "Access Denied");
        if (!employeeActive(state)) return deny(res, 403, "Access Denied", { error: "EMPLOYEE_INACTIVE" });
      } catch (err) {
        return deny(res, 500, "An error occurred !");
      }
    }

    if (userUsecase && config.login.tokenValidFromEnabled) {
      try {
        const state = await loadSession(userId);
        if (!state || Number(state.status) !== 1) return deny(res, 403, "Access Denied");
        if (state.token_valid_from) {
          const validFrom = Math.floor(new Date(state.token_valid_from).getTime() / 1000);
          if (typeof decoded.iat === "number" && decoded.iat < validFrom) {
            return deny(res, 403, "Access Denied", { error: "TOKEN_REVOKED" });
          }
        }
      } catch (err) {
        // Failing closed: a session check that cannot run must not open the door.
        return deny(res, 500, "An error occurred !");
      }
    }

    if (req.auth.mustChangePassword && config.password.enforcePasswordChange) {
      const allowed = passwordChangeAllowed[req.path];
      if (!allowed || !allowed[req.method.toLowerCase()]) {
        return deny(res, 403, "Password change required", { error: "PASSWORD_CHANGE_REQUIRED" });
      }
    }

    next();
  };

  middleware.invalidate = invalidate;
  return middleware;
}

const defaultMiddleware = create();

module.exports = defaultMiddleware;
module.exports.create = create;
module.exports.unProtectedRoutes = unProtectedRoutes;
module.exports.resolveIdentity = resolveIdentity;
