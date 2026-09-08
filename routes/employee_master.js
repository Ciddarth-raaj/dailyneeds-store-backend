const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const { EDITABLE_FIELDS } = require("../repository/employee_master");
const { getClientIp } = require("../utils/ip");

const router = express.Router();

/**
 * Stage 0C / C2 — the local employee-master API, mounted at /hr.
 *
 * A separate router rather than four more routes bolted onto the 600-line
 * employee router: these are the lifecycle actions, they carry their own
 * permissions, and keeping them together is what lets C3 find them.
 *
 * B3 IS UNCHANGED AND STILL AUTHORITATIVE. `filterResponse` and `guardWrite`
 * are applied to this router exactly as they are to /employee, so a caller
 * without `view_employee_sensitive` never sees salary, bank, PAN, Aadhaar,
 * UAN, PF or ESI here, and a body that so much as mentions one of them is
 * refused unless the caller holds `edit_employee_sensitive`. HR owning the
 * employee record does not make HR entitled to everything on it.
 */
class EmployeeMasterRoutes {
  constructor(employeeMasterUsecase, permissions, sensitive, aadhaarUsecase, bankUsecase, statusSummaryUsecase) {
    this.usecase = employeeMasterUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.aadhaar = aadhaarUsecase || null;
    this.bank = bankUsecase || null;
    this.statusSummary = statusSummaryUsecase || null;
    this.setupRoutes();
  }

  /** Errors carry their own status; anything else is a 500 without detail. */
  _fail(res, err) {
    if (err && err.httpCode) {
      // A refusal that knows WHICH employee already holds this Aadhaar is far
      // more useful than one that does not - it is what turns "refused" into
      // "use Rejoin on 412". Allowlisted by key rather than spread, so an
      // error can never widen this response by attaching something else.
      const detail =
        err.detail && Number.isInteger(Number(err.detail.existing_employee_id))
          ? { existing_employee_id: Number(err.detail.existing_employee_id) }
          : {};
      res.json({ code: err.httpCode, msg: err.message, ...detail });
      return;
    }
    if (err && err.name === "ValidationError") {
      res.json({ code: 422, msg: err.toString() });
      return;
    }
    console.log(err);
    res.json({ code: 500, msg: "An error occurred !" });
  }

  /** The acting employee, for the lifecycle event's actor column. */
  _actor(req) {
    const id = req.auth && req.auth.employeeId;
    return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  }

  setupRoutes() {
    router.use(this.sensitive.filterResponse);
    router.use(this.sensitive.guardWrite);

    /* ------------------------------------------------------------ create */
    router.post("/employee", this.permissions.require(P.EMPLOYEE_CREATE), async (req, res) => {
      try {
        const schema = Joi.object()
          .keys({
            employee_name: Joi.string().trim().min(1).required(),
            date_of_joining: Joi.string().required(),
            store_id: Joi.number().integer().positive().required(),
            designation_id: Joi.number().integer().positive().required(),
            department_id: Joi.number().integer().positive().required(),
            shift_id: Joi.number().integer().positive().optional(),
            primary_contact_number: Joi.string().trim().optional(),
            father_name: Joi.string().allow("", null).optional(),
            dob: Joi.string().allow("", null).optional(),
            gender: Joi.string().allow("", null).optional(),
            marital_status: Joi.string().allow("", null).optional(),
            marriage_date: Joi.string().allow("", null).optional(),
            spouse_name: Joi.string().allow("", null).optional(),
            permanent_address: Joi.string().allow("", null).optional(),
            residential_address: Joi.string().allow("", null).optional(),
            alternate_contact_number: Joi.string().allow("", null).optional(),
            email_id: Joi.string().trim().allow("", null).optional(),
            blood_group: Joi.string().allow("", null).optional(),
            qualification: Joi.string().allow("", null).optional(),
            introducer_name: Joi.string().allow("", null).optional(),
            introducer_details: Joi.string().allow("", null).optional(),
            previous_experience: Joi.string().allow("", null).optional(),
            additional_course: Joi.string().allow("", null).optional(),
            uniform_qty: Joi.number().allow("", null).optional(),
            employee_image: Joi.string().allow("", null).optional(),
            telegram_username: Joi.string().allow("", null).optional(),
            online_portal: Joi.number().optional(),
            // Stage 0C / C2. When present, the employee is created with a
            // verified Aadhaar identity attached in the same transaction.
            aadhaar_verification_id: Joi.number().integer().positive().optional(),
          })
          // employee_id is absent on purpose: the database allocates it, and
          // accepting one from a client is what would make identity guessable.
          .unknown(false);

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.usecase.createEmployee(req.body, { actorEmployeeId: this._actor(req) }));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* -------------------------------------------------------------- edit */
    router.post("/employee/:employee_id/edit", this.permissions.require(P.EMPLOYEE_EDIT), async (req, res) => {
      try {
        const employeeId = Number(req.params.employee_id);
        if (!Number.isInteger(employeeId) || employeeId <= 0) {
          res.json({ code: 422, msg: "employee_id must be a positive integer" });
          res.end();
          return;
        }
        // Every editable column, and nothing else. A body naming employee_id,
        // status or a lifecycle date is refused by the usecase with a message
        // pointing at the right action.
        const keys = {};
        for (const f of EDITABLE_FIELDS) keys[f] = Joi.any().optional();
        const isValid = Joi.validate(req.body, Joi.object().keys(keys).unknown(true));
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.usecase.editEmployee(employeeId, req.body, { actorEmployeeId: this._actor(req) })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* ------------------------------------------------------------ resign */
    router.post("/employee/:employee_id/resign", this.permissions.require(P.EMPLOYEE_RESIGN), async (req, res) => {
      try {
        const employeeId = Number(req.params.employee_id);
        const schema = {
          resignation_date: Joi.string().required(),
          reason_type: Joi.string().allow("", null).optional(),
          reason: Joi.string().allow("", null).optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.usecase.resignEmployee(employeeId, req.body, { actorEmployeeId: this._actor(req) })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* ------------------------------------------------------------ rejoin */
    router.post("/employee/:employee_id/rejoin", this.permissions.require(P.EMPLOYEE_REJOIN), async (req, res) => {
      try {
        const employeeId = Number(req.params.employee_id);
        const schema = {
          date_of_joining: Joi.string().required(),
          previous_ended_on: Joi.string().allow("", null).optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.usecase.rejoinEmployee(employeeId, req.body, { actorEmployeeId: this._actor(req) })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* --------------------------------------------------- lifecycle reads */
    router.get(
      "/employee/:employee_id/lifecycle",
      this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE),
      async (req, res) => {
        try {
          res.json(await this.usecase.getLifecycleHistory(Number(req.params.employee_id)));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /* ---------------------------------------------- the list status columns */
    /**
     * Aadhaar and bank status for a whole employee list, in one request.
     *
     * WHY IT IS GATED ON `view_employees` AND NOTHING ELSE. It shows exactly
     * the employees `GET /employee/employees` already shows the same caller -
     * the population comes from that very call - and it adds two badges to
     * them. It is a column on a list somebody can already see, so it is the
     * list's permission.
     *
     * It is deliberately NOT gated on `view_employee_sensitive`: knowing that
     * an employee's bank details are unverified is what HR needs in order to
     * chase them, and it discloses nothing about the account. Nothing here
     * is sensitive under B3 - there is no account number, no last four
     * digits, no IFSC, no Aadhaar digits, no fingerprint - so B3's
     * `filterResponse` has nothing to strip, which is the point.
     *
     * The same `store_ids` / `designation_ids` filters as the employee list,
     * so a filtered list asks for a filtered summary.
     */
    router.get("/employees/status-summary", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        if (!this.statusSummary) {
          res.json({ code: 503, msg: "The employee status summary is not configured on this server" });
          res.end();
          return;
        }
        const schema = {
          store_ids: Joi.array().items(Joi.number().required()).optional(),
          designation_ids: Joi.array().items(Joi.number().required()).optional(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.statusSummary.list(req.query));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /**
     * "Have we got this person already?" - for a create with no Aadhaar.
     *
     * ADVISORY. It writes nothing, blocks nothing and is not a precondition
     * of POST /employee; HR may review the answer and create anyway. Gated on
     * `employee_create` because it is part of that screen and it reads other
     * employees' names, contact numbers and dates of birth.
     */
    router.post("/employee/check-duplicate", this.permissions.require(P.EMPLOYEE_CREATE), async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, {
          employee_name: Joi.string().allow("", null).optional(),
          primary_contact_number: Joi.string().allow("", null).optional(),
          dob: Joi.string().allow("", null).optional(),
        });
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.usecase.findPossibleDuplicates(req.body || {}));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* ------------------------------------------------------------ Aadhaar */
    /**
     * Step 1: send the OTP.
     *
     * Gated on `employee_create` at the route, and on `edit_employee_sensitive`
     * by B3 - the body carries `aadhaar_number`, which is a sensitive field,
     * so `guardWrite` refuses the request outright without that permission.
     * Two layers, neither of them new.
     */
    router.post("/aadhaar/initiate", this.permissions.require(P.EMPLOYEE_CREATE), async (req, res) => {
      try {
        if (!this.aadhaar) {
          res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
          res.end();
          return;
        }
        const schema = {
          aadhaar_number: Joi.string().required(),
          consent_given: Joi.boolean().required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.aadhaar.initiate(req.body, {
            actorEmployeeId: this._actor(req),
            ip: getClientIp(req),
          })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /**
     * Step 2: exchange the OTP for verified demographics and the duplicate
     * decision. The OTP is an argument to one provider call and is never
     * stored, logged or echoed.
     */
    router.post("/aadhaar/verify-otp", this.permissions.require(P.EMPLOYEE_CREATE), async (req, res) => {
      try {
        if (!this.aadhaar) {
          res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
          res.end();
          return;
        }
        const schema = {
          verification_token: Joi.string().required(),
          otp: Joi.string().required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.aadhaar.verifyOtp(req.body, { actorEmployeeId: this._actor(req) }));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /**
     * VERIFIED or PENDING, and the last four when there is one.
     *
     * Never 404: an employee with no Aadhaar is PENDING, not missing. That is
     * what lets C3 render one badge for every employee, including the 630 who
     * predate any of this, without special-casing an absence.
     */
    router.get(
      "/employee/:employee_id/aadhaar",
      this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE),
      async (req, res) => {
        try {
          res.json(await this.usecase.getAadhaarStatus(Number(req.params.employee_id)));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * Attach a verified Aadhaar to an employee who already exists - the other
     * half of "Skip for now". Same permanent employee_id; no employee is
     * created here, and an Aadhaar already held by somebody else is refused
     * with that employee's id rather than attached.
     */
    router.post(
      "/employee/:employee_id/aadhaar/attach",
      this.permissions.require(P.EMPLOYEE_EDIT),
      async (req, res) => {
        try {
          if (!this.aadhaar) {
            res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
            res.end();
            return;
          }
          const isValid = Joi.validate(req.body || {}, {
            aadhaar_verification_id: Joi.number().integer().positive().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.usecase.attachAadhaar(Number(req.params.employee_id), req.body, {
              actorEmployeeId: this._actor(req),
            })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * The full number, for PF and ESI filing.
     *
     * BOTH keys, not either: `view_employee_sensitive` is what B3 requires to
     * let an Aadhaar value through `filterResponse` at all, and
     * `view_aadhaar_full` is the additional, specific decision that this
     * caller may read all twelve digits rather than the last four. Requiring
     * only the second would mean B3 silently stripped the very field the
     * route exists to return - the two layers must agree, and `requireAll`
     * is how that is said.
     *
     * Every read is logged with who read it.
     */
    router.get(
      "/employee/:employee_id/aadhaar/full",
      this.permissions.requireAll(P.VIEW_EMPLOYEE_SENSITIVE, P.VIEW_AADHAAR_FULL),
      async (req, res) => {
        try {
          if (!this.aadhaar) {
            res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
            res.end();
            return;
          }
          res.json(
            await this.aadhaar.revealFullNumber(Number(req.params.employee_id), {
              actorEmployeeId: this._actor(req),
            })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /* --------------------------------------------------------------- bank */
    /**
     * Run a Penny-Less check against the account already on the employee.
     *
     * The account number is NOT accepted in the body: it is read from the
     * employee record inside the usecase, so a full account number never
     * needs to cross this boundary, and a verification can never be run
     * against details that were not saved.
     *
     * This is the ONLY route that calls the provider. Displaying an employee,
     * or polling the status endpoint below, never does.
     */
    router.post(
      "/employee/:employee_id/bank/verify",
      this.permissions.requireAll(P.VERIFY_EMPLOYEE_BANK, P.VIEW_EMPLOYEE_SENSITIVE),
      async (req, res) => {
        try {
          if (!this.bank) {
            res.json({ code: 503, msg: "Bank verification is not configured on this server" });
            res.end();
            return;
          }
          res.json(
            await this.bank.verify(Number(req.params.employee_id), { actorEmployeeId: this._actor(req) })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /** The current status. Read-only, and never calls the provider. */
    router.get(
      "/employee/:employee_id/bank/verification",
      this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE),
      async (req, res) => {
        try {
          if (!this.bank) {
            res.json({ code: 503, msg: "Bank verification is not configured on this server" });
            res.end();
            return;
          }
          res.json(await this.bank.getStatus(Number(req.params.employee_id)));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * Accept a name the bank spelled differently. Its own permission, because
     * this is the one place a human overrides a check.
     */
    router.post(
      "/employee/:employee_id/bank/confirm-name",
      this.permissions.requireAll(P.CONFIRM_BANK_NAME_MISMATCH, P.VIEW_EMPLOYEE_SENSITIVE),
      async (req, res) => {
        try {
          if (!this.bank) {
            res.json({ code: 503, msg: "Bank verification is not configured on this server" });
            res.end();
            return;
          }
          const isValid = Joi.validate(req.body || {}, { note: Joi.string().allow("", null).optional() });
          if (isValid.error !== null) throw isValid.error;
          res.json(
            await this.bank.confirmNameMismatch(Number(req.params.employee_id), {
              actorEmployeeId: this._actor(req),
              note: (req.body || {}).note,
            })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * Allow two active employees to share one bank account.
     *
     * Its own key, held by nobody by default, so in practice this is an
     * administrator through the `user_type = 2` bypass. Deliberately out of
     * HR's reach: the normal resolution to a duplicate is that somebody typed
     * the wrong account, and the person who typed it should not be the person
     * who waves it through. A stated reason is required and audited.
     */
    router.post(
      "/employee/:employee_id/bank/override-duplicate",
      this.permissions.requireAll(P.OVERRIDE_DUPLICATE_BANK_ACCOUNT, P.VIEW_EMPLOYEE_SENSITIVE),
      async (req, res) => {
        try {
          if (!this.bank) {
            res.json({ code: 503, msg: "Bank verification is not configured on this server" });
            res.end();
            return;
          }
          const isValid = Joi.validate(req.body || {}, { reason: Joi.string().min(3).required() });
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.bank.overrideDuplicate(Number(req.params.employee_id), {
              actorEmployeeId: this._actor(req),
              reason: (req.body || {}).reason,
            })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    router.get("/lifecycle/review", this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE), async (req, res) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        res.json(await this.usecase.getReviewList({ limit, offset }));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (
  employeeMasterUsecase,
  permissions,
  sensitive,
  aadhaarUsecase,
  bankUsecase,
  statusSummaryUsecase
) =>
  new EmployeeMasterRoutes(
    employeeMasterUsecase,
    permissions,
    sensitive,
    aadhaarUsecase,
    bankUsecase,
    statusSummaryUsecase
  );
