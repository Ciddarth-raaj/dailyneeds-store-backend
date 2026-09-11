const router = require("express").Router();
const P = require("../constants/hr_permissions");
const lifecycleConfig = require("../config/lifecycle");
const { requireEmployee, employeeIdOrNull } = require("../utils/actor");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const {
  sectionKeysRequired,
  isSectionOnlyWrite,
} = require("../constants/employee_master_sections");

class EmployeeRoutes {
  constructor(employeeUsecase, permissions, sensitive) {
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.employeeUsecase = employeeUsecase;

    this.init();
  }

  init() {
    // Stage 0B / B3. Every route below returns employee rows, and several of
    // them do it with SELECT *, so the field-level guard is mounted once for
    // the whole router rather than repeated per route - a route added later
    // is covered by construction instead of by remembering.
    //
    //   filterResponse  strips salary, bank, PAN, Aadhaar, UAN, PF and ESI
    //                   from the response unless the caller holds
    //                   view_employee_sensitive
    //   guardWrite      403s a body that mentions any of them unless the
    //                   caller holds edit_employee_sensitive (a no-op on
    //                   requests with no body, so GETs are unaffected)
    router.use(this.sensitive.filterResponse);
    router.use(this.sensitive.guardWrite);

    router.post("/", this.permissions.require(P.ADD_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
          employee_name: Joi.string().required(),
          father_name: Joi.string().optional(),
          dob: Joi.string().optional(),
          permanent_address: Joi.string().optional(),
          residential_address: Joi.string().optional(),
          primary_contact_number: Joi.number()
            .min(100000000)
            .max(99999999999)
            .required(),
          alternate_contact_number: Joi.number()
            .min(100000000)
            .allow("")
            .allow(null)
            .max(99999999999)
            .optional(),
          email_id: Joi.string()
            .trim()
            .allow("")
            .allow(null)
            .email()
            .optional(),
          qualification: Joi.string().allow("").allow(null).optional(),
          introducer_name: Joi.string().allow("").allow(null).optional(),
          introducer_details: Joi.string().allow("").allow(null).optional(),
          salary: Joi.number().required(),
          uniform_qty: Joi.number().allow("").allow(null).optional(),
          previous_experience: Joi.string().allow("").allow(null).optional(),
          date_of_joining: Joi.string().allow("").allow(null).optional(),
          gender: Joi.string().required(),
          payment_type: Joi.number().required(),
          blood_group: Joi.string().allow("").allow(null).optional(),
          designation_id: Joi.number().required(),
          store_id: Joi.number().required(),
          shift_id: Joi.number().allow("").allow(null).optional(),
          department_id: Joi.number().required(),
          marital_status: Joi.string().optional(),
          marriage_date: Joi.string().allow("").allow(null).optional(),
          employee_image: Joi.string().allow("").allow(null).optional(),
          pan_no: Joi.string().allow("").allow(null).optional(),
          bank_name: Joi.string().allow("").allow(null).optional(),
          ifsc: Joi.string().allow("").optional(),
          account_no: Joi.string().allow("").allow(null).optional(),
          esi: Joi.string().allow("").optional(),
          esi_number: Joi.string().allow("").allow(null).optional(),
          pf: Joi.string().allow("").optional(),
          pf_number: Joi.string().allow("").allow(null).optional(),
          UAN: Joi.string().allow("").allow(null).optional(),
          additional_course: Joi.string().allow("").allow(null).optional(),
          spouse_name: Joi.string().allow("").allow(null).optional(),
          telegram_username: Joi.string().allow("").allow(null).optional(),
          online_portal: Joi.number().optional(),
          aadhaar_card_no: Joi.string().allow("").allow(null).optional(),
          aadhaar_card_name: Joi.string().allow("").allow(null).optional(),
          aadhaar_card_image: Joi.string().allow("").allow(null).optional(),
          files: Joi.array()
            .items({
              id_card: Joi.string().allow("").allow(null).required(),
              id_card_no: Joi.string().allow("").required(),
              id_card_name: Joi.string().allow("").required(),
              expiry_date: Joi.date().allow("").allow(null).optional(),
              file: Joi.string().allow("").required(),
            })
            .optional(),
        };

        const employee = req.body;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const response = await this.employeeUsecase.create(employee);

        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }

      res.end();
    });

    router.get("/employees", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          store_ids: Joi.array().items(Joi.number().required()).optional(),
          designation_ids: Joi.array()
            .items(Joi.number().required())
            .optional(),
        };

        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        const employee = await this.employeeUsecase.get(req.query);
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });

    router.get("/headcount", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getHeadCount();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
    router.get("/familydet", this.permissions.require(P.VIEW_FAMILY), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getFamilyDet();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
    router.get("/bank", this.permissions.require(P.VIEW_BANKS), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getBankDetails();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
    router.get("/resignedemp", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getResignedEmployee();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
    router.get("/newjoinee", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().required(),
          offset: Joi.number().required(),
        };
        const data = req.query;
        const isValid = Joi.validate(data, schema);

        if (isValid.error !== null) {
          console.log({ err: isValid.error });
          throw isValid.error;
        }
        const employee = await this.employeeUsecase.getnewJoinee(
          data.limit,
          data.offset
        );
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !", err: err });
        }
      }

      res.end();
    });
    router.get("/newjoiner", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getNewJoiner();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });

    router.get("/birthday", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getEmployeeBirthday();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
    router.get("/filter", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          filter: Joi.string().required(),
        };
        const employee = req.query;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.employeeUsecase.getEmployeeByFilter(
          employee.filter
        );
        res.json(data);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
    router.get("/anniversary", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getJoiningAnniversary();
        res.json(employee);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });

    router.get("/store_id", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          store_id: Joi.number().required(),
        };
        const employee = req.query;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.employeeUsecase.getEmployeeByStore(
          employee.store_id
        );
        res.json(data);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    router.get("/employee_id", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
        };
        const employee = req.query;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.employeeUsecase.getEmployeeById(
          employee.employee_id
        );
        res.json(data);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });

    // Stage 0B follow-up: the operational employee directory.
    //
    // B2 put `view_employees` in front of /employee/employees, which is right
    // - that route returns the whole employee record. But the accounts sheet
    // only ever needed a name to put in a dropdown, and taking the HR
    // permission away emptied it. Granting `view_employees` back to every
    // outlet user to fix a dropdown would undo B2; this returns the two
    // columns the dropdown actually uses instead.
    //
    // Authenticated (B1 covers it - the path is not in unProtectedRoutes) and
    // deliberately NOT gated on `view_employees`. What keeps it safe is what
    // it can return, not who may call it:
    //
    //   * two columns, employee_id and employee_name, named in the SQL
    //   * active employees only
    //   * the caller's OWN outlet, taken from the token, never from the query
    //
    // A non-admin's `store_id` parameter is ignored rather than rejected, so
    // a stale frontend cannot read another branch's staff list by asking. An
    // admin (user_type 2) may name a store, because the accounts screens let
    // an admin work on a branch that is not their own; without one they get
    // their own, and an account with no store gets an empty list rather than
    // everybody.
    router.get("/directory", async (req, res) => {
      try {
        const isAdmin = Number(req.auth && req.auth.userType) === this.permissions.ADMIN_USER_TYPE;
        const requested = Number(req.query.store_id);
        const ownStore = req.auth ? req.auth.storeId : null;
        const storeId = isAdmin && Number.isInteger(requested) && requested > 0 ? requested : ownStore;

        if (storeId === null || storeId === undefined || storeId === "") {
          return res.json([]);
        }

        const data = await this.employeeUsecase.getDirectory(storeId);
        res.json(data);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred !" });
      }
    });

    router.get("/get-details", async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
        };
        const employee_id = requireEmployee(req, "Fetching the signed-in employee");
        const isValid = Joi.validate({ employee_id }, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const data = await this.employeeUsecase.getEmployeeById(employee_id);
        res.json(data);
      } catch (err) {
        if (err.name === "SystemAccountError") {
          // A break-glass session has no employee record to fetch (A3).
          res.status(403).json({ code: 403, error: err.code, msg: err.message });
        } else {
          console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
      }

      res.end();
    });

    router.post("/update-status", this.permissions.require(P.ADD_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
          status: Joi.number().required(),
        };

        const employee = req.body;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.employeeUsecase.updateStatus(employee);
        res.json({ code: code });
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });
    router.post("/updatedata", this.updateDataGuard(), async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),

          employee_details: Joi.object({
            employee_id: Joi.string().allow("").allow(null).optional(),
            telegram_username: Joi.string().allow("").allow(null).optional(),
            aadhaar_card_no: Joi.string().allow("").allow(null).optional(),
            aadhaar_card_name: Joi.string().allow("").allow(null).optional(),
            aadhaar_card_image: Joi.string().allow("").allow(null).optional(),
            employee_name: Joi.string().allow("").allow(null).optional(),
            father_name: Joi.string().allow("").allow(null).optional(),
            dob: Joi.string().allow("").allow(null).optional(),
            permanent_address: Joi.string().allow("").allow(null).optional(),
            residential_address: Joi.string().allow("").allow(null).optional(),
            primary_contact_number: Joi.number()
              .min(100000000)
              .max(99999999999)
              .optional(),
            alternate_contact_number: Joi.number()
              .min(100000000)
              .allow("")
              .allow(null)
              .max(99999999999)
              .optional(),
            email_id: Joi.string().trim().email().allow(null).optional(),
            qualification: Joi.string().allow("").allow(null).optional(),
            introducer_name: Joi.string().allow("").allow(null).optional(),
            introducer_details: Joi.string().allow("").allow(null).optional(),
            // M1 review fix - `salary` IS NOT LISTED HERE ON PURPOSE.
            //
            // Final business rule: salary is not writable through the
            // Employee Master legacy edit APIs. It belongs to the dedicated
            // Payroll / Salary Revision system, and until that exists the
            // Payroll section of the profile is read-only.
            //
            // Removing the key is the whole mechanism: Joi runs without
            // `allowUnknown`, so a body that names `salary` fails validation
            // and is answered 422 before `updateEmployeeDetails` is reached.
            // The repository builds its UPDATE from whatever object it is
            // handed (`SET ?`), so refusing the field at the edge is what
            // stops the column being written, not a filter further in.
            uniform_qty: Joi.number().allow("").allow(null).optional(),
            previous_experience: Joi.string().allow("").allow(null).optional(),
            date_of_joining: Joi.string().allow("").allow(null).optional(),
            gender: Joi.string().allow("").allow(null).optional(),
            payment_type: Joi.number().allow("").allow(null).optional(),
            blood_group: Joi.string().allow("").allow(null).optional(),
            designation_id: Joi.number().allow("").allow(null).optional(),
            store_id: Joi.number().allow("").allow(null).optional(),
            shift_id: Joi.number().allow("").allow(null).optional(),
            department_id: Joi.number().allow("").allow(null).optional(),
            marital_status: Joi.string().allow("").allow(null).optional(),
            marriage_date: Joi.string().allow("").allow(null).optional(),
            pan_no: Joi.string().allow("").allow(null).optional(),
            bank_name: Joi.string().allow("").allow(null).optional(),
            ifsc: Joi.string().allow("").allow(null).optional(),
            account_no: Joi.string().allow("").allow(null).optional(),
            esi: Joi.string().allow("").allow(null).optional(),
            esi_number: Joi.string().allow("").allow(null).optional(),
            pf: Joi.string().allow("").allow(null).optional(),
            pf_number: Joi.string().allow("").allow(null).optional(),
            // Stage 0C / C3 follow-up. Tri-state on purpose: 1 in the scheme,
            // 0 not applicable, null nobody has said yet. `null` has to be
            // accepted so a flag set by mistake can be put back to "not
            // recorded" rather than being forced to 0, which would be an
            // assertion nobody made.
            pf_applicable: Joi.number().integer().min(0).max(1).allow(null).optional(),
            esi_applicable: Joi.number().integer().min(0).max(1).allow(null).optional(),
            UAN: Joi.string().allow("").allow(null).optional(),
            additional_course: Joi.string().allow("").allow(null).optional(),
            spouse_name: Joi.string().allow("").allow(null).optional(),
            online_portal: Joi.number().allow(null).optional(),
            modified_employee_image: Joi.string()
              .allow("")
              .allow(null)
              .optional(),
            files: Joi.array()
              .items({
                id_card: Joi.string().allow("").required(),
                id_card_no: Joi.number().allow("").required(),
                id_card_name: Joi.string().allow("").required(),
                expiry_date: Joi.date().allow("").allow(null).optional(),
                file: Joi.string().allow("").required(),
              })
              .optional(),
            docupdate: Joi.array()
              .items({
                card_name: Joi.string().allow("").allow(null).optional(),
                card_no: Joi.string().allow("").allow(null).optional(),
                card_type: Joi.string().allow("").allow(null).required(),
                file: Joi.string().allow("").allow(null).optional(),
              })
              .optional(),
          }).optional(),
        };

        const employee = req.body;

        if (employee.employee_details.docupdate) {
          for (
            let i = 0;
            i <= employee.employee_details.docupdate.length - 1;
            i++
          ) {
            if (employee.employee_details.docupdate[i].file === "") {
              delete employee.employee_details.docupdate[i].file;
            }
          }
        }

        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        // M1. Payment Details and Statutory Details are separate sections
        // with separate keys, on top of `edit_employee_sensitive` (B3's
        // guardWrite, mounted on the router) and - for anything that is not a
        // section-only write - `add_employees` (see `updateDataGuard`).
        // Refused as a whole, like B3: a body that names a column the caller
        // may not write is not partially applied.
        //
        // This runs AFTER Joi rather than in the guard so the shape is known
        // to be valid before a permission decision is made from it.
        const sectionKeys = sectionKeysRequired(employee.employee_details);
        if (sectionKeys.length > 0 && !(await this.permissions.hasAll(req, ...sectionKeys))) {
          res.status(403).json({
            code: 403,
            msg: "You do not have permission to change these employee details",
            required_permissions: sectionKeys,
          });
          res.end();
          return;
        }
        const code = await this.employeeUsecase.updateEmployeeDetails(employee);
        res.json({ code: code });
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    // Sync all data
    router.post("/sync", this.permissions.require(P.ADD_EMPLOYEES), async (req, res) => {
      try {
        // Stage 0C: answer the caller plainly rather than reporting a
        // successful sync that the service layer then declines to perform.
        // 423 Locked - the resource is fine, it is deliberately unavailable.
        // syncDigismeEmployees() carries the same guard; this one exists so
        // the person who pressed the button learns why nothing happened.
        if (!lifecycleConfig.digisme.employeeSync) {
          return res
            .status(423)
            .json({ code: 423, msg: lifecycleConfig.PAUSED_MESSAGE, paused: true });
        }

        await this.employeeUsecase.sync();
        res.json({ code: 200, msg: "Data successfully synced!" });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred!" });
      }
    });
  }

  /**
   * The guard on the legacy employee-master write, chosen from the body.
   *
   * M1 review fix. `add_employees` used to gate the whole route, which made
   * the two post-onboarding section keys ungrantable in practice: a
   * designation holding `edit_employee_sensitive` and `edit_payment_details`
   * still could not save Payment Details on an existing employee unless it
   * could also CREATE employees. Add Employee covers onboarding screens 1-4
   * and stops at Education; the sections after it are controlled by their own
   * designation rights.
   *
   * So the key is demanded for everything this legacy route has always
   * carried - ordinary columns, `files`, `docupdate`, the lot - and NOT for a
   * body that writes only Payment Details and / or Statutory Details columns.
   *
   * NOTHING IS WEAKENED BY THIS. A section-only body is still refused twice
   * over: by B3's `guardWrite` unless the caller holds
   * `edit_employee_sensitive` (every column concerned is sensitive), and by
   * the handler's own `hasAll` on `edit_payment_details` /
   * `edit_statutory_details`. The set of callers who can write these columns
   * is therefore the same as before MINUS the `add_employees` requirement,
   * which is exactly the change that was approved - and admins still reach it
   * through the middleware's user_type 2 bypass, unchanged.
   *
   * ANYTHING UNRECOGNISED KEEPS THE OLD REQUIREMENT. An absent, empty or
   * malformed `employee_details` is not a section-only write, so it demands
   * `add_employees` exactly as it did before.
   */
  updateDataGuard() {
    const guard = (req, res, next) => {
      const details = req && req.body ? req.body.employee_details : undefined;
      if (isSectionOnlyWrite(details)) return next();
      return this.permissions.require(P.ADD_EMPLOYEES)(req, res, next);
    };

    // So the route tests can read the wiring rather than the source text,
    // exactly as `employee_work_shift.js#assignGuard` does.
    guard.__guard = {
      mode: "any",
      keys: [P.ADD_EMPLOYEES],
      dynamic: {
        sectionOnly: [],
        otherwise: [P.ADD_EMPLOYEES],
      },
    };

    return guard;
  }

  getRouter() {
    return router;
  }
}

module.exports = (employeeUsecase, permissions, sensitive) => {
  return new EmployeeRoutes(employeeUsecase, permissions, sensitive);
};
