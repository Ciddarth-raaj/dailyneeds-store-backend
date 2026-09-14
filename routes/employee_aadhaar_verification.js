const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const { getClientIp } = require("../utils/ip");

/**
 * THE EXISTING-EMPLOYEE AADHAAR VERIFICATION PATH.
 *
 *   POST /hr/employee/:employee_id/aadhaar/initiate
 *   POST /hr/employee/:employee_id/aadhaar/verify-otp
 *
 * ============================== THE DEFECT THIS FIXES =====================
 *
 * Roughly six hundred employees predate Aadhaar verification and carry no
 * identity. The "Verify now" button on the employee profile called the
 * ONBOARDING endpoints - `POST /hr/aadhaar/initiate` and
 * `/hr/aadhaar/verify-otp` - which are gated on `employee_create` and, because
 * the initiate body carries `aadhaar_number`, on `edit_employee_sensitive`
 * through B3's `guardWrite`. A store manager holds neither, so the modal ended
 * in "You do not have permission to perform this action" for an employee they
 * could see, could edit and whose Aadhaar badge they were entitled to read.
 *
 * Granting them `edit_employee_sensitive` would have opened salary, bank, PAN,
 * PF and ESI writes to fix an Aadhaar badge. So instead the EXISTING-employee
 * case gets its own path, its own key, and its own narrower rules. THE
 * ONBOARDING PATH IS UNTOUCHED: `/hr/aadhaar/initiate` and
 * `/hr/aadhaar/verify-otp` keep `employee_create` + B3 exactly as they are,
 * and creating an employee never requires the new key.
 *
 * ========================= WHY THIS ROUTER IS NOT UNDER `guardWrite` ======
 *
 * THIS IS THE ONE THING WORTH READING CAREFULLY, so it is stated in full.
 *
 * B3 IS NOT WEAKENED ANYWHERE. `aadhaar_number` stays in
 * `constants/sensitive_fields.js`, `guardWrite` is unchanged, and every other
 * route on `/hr` and `/employee` still refuses a body that so much as mentions
 * a sensitive field without `edit_employee_sensitive`. What changes is that
 * these two endpoints live on a router of their own, so the generic guard -
 * which exists because a body full of sensitive columns is being written onto
 * an employee row - does not apply to a request that writes none of them.
 *
 * `guardWrite` is a BLANKET rule for routes that take arbitrary employee
 * columns. It is right there and wrong here, for four reasons:
 *
 *   1. THE NUMBER IS NOT WRITTEN TO THE EMPLOYEE. It is validated, checksummed
 *      and handed to the provider, then reduced immediately to fingerprint +
 *      ciphertext + last four on the verification session row. No employee
 *      column is touched by either endpoint - `usecase.initiate` and
 *      `usecase.verifyOtp` write only `employee_aadhaar_verification`.
 *
 *   2. A NARROWER, SPECIFIC AUTHORIZATION RUNS FIRST, AND ALWAYS BEFORE THE
 *      PROVIDER CALL. In order, per request: authentication (`auth`, mounted
 *      app-wide), `verify_employee_aadhaar`, the employee branch scope, the
 *      PENDING-state check, then Joi validation. The handler - and therefore
 *      the provider - is reached only if all five pass. A blanket key is
 *      replaced by a stricter rule, not by no rule.
 *
 *   3. IT CANNOT REACH A SECOND FIELD. The Joi schemas are exact
 *      (`aadhaar_number` + `consent_given`; `verification_token` + `otp`), so
 *      there is no body shape here that could carry a salary or a bank account
 *      the way an employee-edit body can. That is what makes the narrow
 *      exemption safe: the route accepts one sensitive field, for one purpose,
 *      on one employee, in one state.
 *
 *   4. ATTACHING IS STILL A SEPARATE, UNCHANGED DECISION.
 *      `POST /hr/employee/:id/aadhaar/attach` keeps `employee_edit` + branch
 *      scope on the master router, under B3. Verifying produces nothing on the
 *      employee record by itself; someone who holds only the verify key can
 *      run the check and cannot attach the result.
 *
 * `filterResponse` IS STILL APPLIED, so nothing sensitive can leave here
 * either, however the usecase changes later.
 *
 * ================================ THE PENDING-ONLY RULE ===================
 *
 * Both endpoints refuse an employee whose Aadhaar is already VERIFIED, with
 * 409 and no provider call. The new key is for the OLD-EMPLOYEE BACKLOG; it
 * must never become a way to swap or overwrite a verified identity, which
 * stays an HR/Admin process and is out of scope. So the restriction lives on
 * the server, ahead of the work, rather than in the button the frontend draws.
 *
 * ==================================== AND WHAT IS NOT LOGGED ==============
 *
 * No Aadhaar number, OTP, ciphertext or fingerprint is logged here or by the
 * usecase - only employee ids, the verification id and the last four digits.
 */
class EmployeeAadhaarVerificationRoutes {
  constructor(employeeMasterUsecase, aadhaarUsecase, permissions, sensitive, branchScope) {
    if (!branchScope) {
      throw new Error("routes/employee_aadhaar_verification: the employee branch scope is required");
    }
    if (!permissions) {
      throw new Error("routes/employee_aadhaar_verification: permissions are required");
    }
    this.usecase = employeeMasterUsecase;
    this.aadhaar = aadhaarUsecase || null;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.setupRoutes();
  }

  /** Errors carry their own status; anything else is a 500 without detail. */
  _fail(res, err) {
    if (err && err.httpCode) {
      res.json({ code: err.httpCode, msg: err.message });
      return;
    }
    if (err && err.name === "ValidationError") {
      res.json({ code: 422, msg: err.toString() });
      return;
    }
    console.log(err);
    res.json({ code: 500, msg: "An error occurred !" });
  }

  /** The acting employee, for consent and audit columns. */
  _actor(req) {
    const id = req.auth && req.auth.employeeId;
    return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  }

  /**
   * ONLY A PENDING AADHAAR MAY BE VERIFIED THROUGH THIS PATH.
   *
   * Reads the employee's CURRENT status from the server rather than trusting
   * anything in the request, and answers for a missing employee exactly as the
   * status endpoint does - `getAadhaarStatus` throws a 404 for an employee who
   * does not exist. A branch-scoped caller never reaches this: the scope guard
   * ahead of it has already refused every id outside their branches, existing
   * or not, with one indistinguishable refusal.
   *
   * Returns true when the handler may proceed; it has already answered
   * otherwise.
   */
  _requirePending() {
    return async (req, res, next) => {
      try {
        const status = await this.usecase.getAadhaarStatus(Number(req.params.employee_id));
        if (status && String(status.aadhaar_status).toUpperCase() === "VERIFIED") {
          res.json({
            code: 409,
            msg:
              "This employee already has a verified Aadhaar. Replacing a verified Aadhaar is not " +
              "possible here; it is a separate HR process.",
          });
          res.end();
          return;
        }
        return next();
      } catch (err) {
        this._fail(res, err);
        res.end();
      }
    };
  }

  /** The three guards every endpoint here carries, in the order they run. */
  _guards() {
    return [
      this.permissions.require(P.VERIFY_EMPLOYEE_AADHAAR),
      this.branchScope.requireEmployeeInScope(),
      this._requirePending(),
    ];
  }

  setupRoutes() {
    const router = this.router;

    // Responses are filtered exactly as they are on the master router. The
    // WRITE guard is deliberately not mounted - see the note at the top of
    // this file, which is the whole justification.
    if (this.sensitive && this.sensitive.filterResponse) {
      router.use(this.sensitive.filterResponse);
    }

    /**
     * Step 1: send the OTP for an employee who already exists.
     *
     * The Aadhaar number is accepted only here, only after the guards above,
     * and is never written to the employee record by this route.
     */
    router.post(
      "/employee/:employee_id/aadhaar/initiate",
      ...this._guards(),
      async (req, res) => {
        try {
          if (!this.aadhaar) {
            res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
            res.end();
            return;
          }
          const isValid = Joi.validate(req.body || {}, {
            aadhaar_number: Joi.string().required(),
            consent_given: Joi.boolean().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.aadhaar.initiate(
              {
                aadhaar_number: req.body.aadhaar_number,
                consent_given: req.body.consent_given,
              },
              { actorEmployeeId: this._actor(req), ip: getClientIp(req) }
            )
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * Step 2: exchange the OTP for verified demographics.
     *
     * The same narrow authorization as step 1 - a caller must not be able to
     * finish a verification they were not allowed to start, and the employee
     * must still be PENDING when the OTP comes back. The OTP is an argument to
     * one provider call and is never stored, logged or echoed.
     */
    router.post(
      "/employee/:employee_id/aadhaar/verify-otp",
      ...this._guards(),
      async (req, res) => {
        try {
          if (!this.aadhaar) {
            res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
            res.end();
            return;
          }
          const isValid = Joi.validate(req.body || {}, {
            verification_token: Joi.string().required(),
            otp: Joi.string().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.aadhaar.verifyOtp(
              { verification_token: req.body.verification_token, otp: req.body.otp },
              { actorEmployeeId: this._actor(req) }
            )
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (employeeMasterUsecase, aadhaarUsecase, permissions, sensitive, branchScope) =>
  new EmployeeAadhaarVerificationRoutes(
    employeeMasterUsecase,
    aadhaarUsecase,
    permissions,
    sensitive,
    branchScope
  );
module.exports.EmployeeAadhaarVerificationRoutes = EmployeeAadhaarVerificationRoutes;
