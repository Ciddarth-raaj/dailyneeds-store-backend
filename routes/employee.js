const router = require("express").Router();
const P = require("../constants/hr_permissions");
const { requireEmployee, employeeIdOrNull } = require("../utils/actor");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const {
  sectionKeysRequired,
  isSectionOnlyWrite,
  PAYMENT_TYPE,
} = require("../constants/employee_master_sections");

class EmployeeRoutes {
  constructor(employeeUsecase, permissions, sensitive, branchScope) {
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.employeeUsecase = employeeUsecase;
    // EMPLOYEE BRANCH SCOPE. Required, not optional: constructing this router
    // without it would silently restore company-wide employee access to every
    // holder of `view_employees`, which is the defect this exists to close.
    if (!branchScope) {
      throw new Error("routes/employee: the employee branch scope is required");
    }
    this.branchScope = branchScope;

    this.init();
  }

  /**
   * The branches this request may look at, or a refusal already sent.
   *
   * Returns `{ done: true }` when it has answered the request itself, and
   * `{ done: false, store_ids }` otherwise. `store_ids` is `null` for an
   * unrestricted caller and a LIST otherwise - including `[]`, which means no
   * branch is authorized and must never be read as "no restriction".
   */
  async _branches(req, res, requested = null) {
    const scoped = await this.branchScope.listFilters(req, requested);
    if (!scoped.ok) {
      this.branchScope.refuse(res, scoped);
      return { done: true };
    }
    return { done: false, store_ids: scoped.store_ids };
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
          // THE PAYMENT ROUTE, REFUSED AT THE EDGE WHEN IT IS WRONG AND
          // LEFT TO THE DEFAULT WHEN IT IS ABSENT. `valid(1, 2)` is the
          // whole meaning of the column (`constants/employee_master_sections`
          // PAYMENT_TYPE), so a 3, a 0 or a "bank" is a 422 here rather than
          // a row nobody can classify. It stopped being `required()` because
          // a create that says nothing now MEANS something - Cash, applied by
          // the repository - and demanding the field would refuse the very
          // case the default exists for.
          payment_type: Joi.number()
            .valid(PAYMENT_TYPE.BANK, PAYMENT_TYPE.CASH)
            .allow("")
            .allow(null)
            .optional(),
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

        // BRANCH-SCOPED CALLERS CREATE INTO THEIR OWN BRANCH ONLY. `store_id`
        // is required by the schema above, so this always has something to
        // check; HR and administrators are unrestricted and unaffected.
        const target = await this.branchScope.checkTargetBranch(req, employee.store_id);
        if (!target.ok) {
          this.branchScope.refuse(res, target);
          return;
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

        // AUTHORIZATION AND THE CALLER'S OWN FILTER ARE BOTH APPLIED, and they
        // are different things. `listFilters` refuses a request that NAMES a
        // branch outside the caller's scope rather than quietly narrowing it;
        // the actor then carries the scope into the WHERE clause, so the
        // population is restricted in SQL and not after the fact.
        const scoped = await this.branchScope.listFilters(req, req.query.store_ids);
        if (!scoped.ok) return this.branchScope.refuse(res, scoped);

        const actor = await this.branchScope.actorFor(req);
        const employee = await this.employeeUsecase.get(req.query, actor);
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getHeadCount(branches.store_ids);
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getFamilyDet(branches.store_ids);
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getBankDetails(branches.store_ids);
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getResignedEmployee(branches.store_ids);
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getnewJoinee(
          data.limit,
          data.offset,
          branches.store_ids
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getNewJoiner(branches.store_ids);
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getEmployeeBirthday(branches.store_ids);
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
        // THE SEARCH IS SCOPED IN SQL, not trimmed afterwards. An
        // autocomplete that queried every branch and then dropped rows would
        // still have disclosed them to anybody reading the response before the
        // trim - and to anybody calling the API directly.
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const data = await this.employeeUsecase.getEmployeeByFilter(
          employee.filter,
          branches.store_ids
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
        const branches = await this._branches(req, res);
        if (branches.done) return;
        const employee = await this.employeeUsecase.getJoiningAnniversary(branches.store_ids);
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
        // The branch is NAMED by the caller, so naming one outside their
        // scope is refused rather than narrowed - otherwise the count for
        // their own branch would come back under another branch's heading.
        const branches = await this._branches(req, res, employee.store_id);
        if (branches.done) return;
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

    // THE EMPLOYEE DETAIL READ - the one a manager reaches by typing an id
    // into the URL. `requireEmployeeInScope` reads `employee_id` from the
    // query and refuses an employee outside the caller's branches, so
    // changing the id in /employee/<id> reaches a 403 rather than a record.
    // A NON-EXISTENT id gets the SAME refusal, so ids cannot be enumerated.
    router.get(
      "/employee_id",
      this.permissions.require(P.VIEW_EMPLOYEES),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
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
      }
    );

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

    router.post(
      "/update-status",
      this.permissions.require(P.ADD_EMPLOYEES),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
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
      }
    );
    router.post(
      "/updatedata",
      this.updateDataGuard(),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
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
            // M2. Existing / Previous PF Member - a THIRD statutory fact,
            // separate from PF Applicable, the UAN and the PF Number, and
            // deliberately not the legacy free-text `pf` column.
            //
            // Tri-state for the same reason as the two flags above: 1 was
            // already a member, 0 first-time member, null nobody has said yet.
            // The third state is not cosmetic here - it is an input to the
            // EPS split, and the engine reports an unrecorded membership as
            // unresolved rather than picking a side, so collapsing null into
            // 0 would turn "we do not know" into a filed statutory position.
            previous_pf_member: Joi.number().integer().min(0).max(1).allow(null).optional(),
            // M2 review fix. Existing / Previous EPS Member - the FOURTH
            // statutory fact, and the one the pension split actually reads.
            // Official Form 11 asks about prior EPF membership and prior EPS
            // membership separately because the answers differ, so the two are
            // two columns here and the engine never derives one from the
            // other. Tri-state for the same reason as every flag above it.
            previous_eps_member: Joi.number().integer().min(0).max(1).allow(null).optional(),
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
        // BRANCH-TRANSFER PROTECTION. The employee is already known to be
        // inside the caller's branches (the guard above); this stops the same
        // caller moving them OUT of it. `store_id` is an ordinary optional
        // column in the schema, so a body that does not name it is not a
        // transfer and is left alone. HR and administrators are ALL_BRANCHES
        // and keep the transfer capability they have today.
        const transfer = await this.branchScope.checkTargetBranch(
          req,
          (employee.employee_details || {}).store_id
        );
        if (!transfer.ok) {
          this.branchScope.refuse(res, transfer);
          res.end();
          return;
        }

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
      }
    );

    // POST /employee/sync is GONE. It triggered the Digisme employee sync,
    // which has been removed - see docs/digisme-employee-sync-removal.md.
    // dnds.co.in is the employee master; employees are created, edited,
    // resigned and rejoined through the local actions on this router.
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

module.exports = (employeeUsecase, permissions, sensitive, branchScope) => {
  return new EmployeeRoutes(employeeUsecase, permissions, sensitive, branchScope);
};
