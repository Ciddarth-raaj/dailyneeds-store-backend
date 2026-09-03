// routes/advance_request.js
const router = require("express").Router();
const Joi = require("@hapi/joi");

/** Nothing may ask for more than this in one page. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;

const STATUSES = [
  "submitted",
  "verified",
  "on_hold",
  "approved",
  "rejected",
  "paid",
];

const SORT_FIELDS = [
  "advance_request_id",
  "invoice_number",
  "amount",
  "status",
  "created_at",
  "updated_at",
];

/**
 * Mirrors the four STAGE_FORMS schemas in the web app
 * (pages/lr-workflow/advance-request/[...params].jsx). The form is a
 * convenience; this is what actually decides whether a stage is valid.
 */
const a1Schema = {
  // An advance is often asked for before any invoice number exists, so the
  // reference is optional; the distributor and the amount are not.
  invoice_number: Joi.string().max(100).allow(null, "").optional(),
  distributor_code: Joi.number().required(),
  amount: Joi.number().greater(0).required(),
  reason: Joi.string().max(500).allow(null, "").optional(),
  outlet_id: Joi.number().allow(null).optional(),
};

const balanceCheckSchema = {
  pending_bills: Joi.number().min(0).required(),
  previous_advance_balance: Joi.number().min(0).required(),
  balance_remarks: Joi.string().max(500).required(),
  on_hold: Joi.boolean().optional(),
};

const approvalSchema = {
  approval_status: Joi.number().valid([0, 1]).required(),
  approval_note: Joi.string().max(500).allow(null, "").optional(),
};

const paymentSchema = {
  paid_amount: Joi.number().greater(0).required(),
  utr: Joi.string().max(100).required(),
  bank_id: Joi.number().required(),
  payment_date: Joi.string().isoDate().required(),
};

const documentSchema = {
  stage: Joi.string().valid(["a1", "a3"]).required(),
  file_url: Joi.string().max(500).required(),
};

/**
 * The column is a DATE, so a full ISO timestamp would not store cleanly.
 * Same normalisation the ticket routes apply.
 */
const normaliseDate = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  return String(value).slice(0, 10);
};

class AdvanceRequestRoutes {
  constructor(advanceRequestUsecase, permissions) {
    this.advanceRequestUsecase = advanceRequestUsecase;
    this.permissions = permissions;
    this.init();
  }

  /** Turns a thrown error into the response shape the app already expects. */
  fail(res, err) {
    if (err && err.name === "ValidationError") {
      res.status(400).json({ code: 422, msg: err.toString() });
    } else if (err && err.name === "NotFoundError") {
      res.status(404).json({ code: 404, msg: err.message });
    } else if (err && err.name === "ConflictError") {
      // The request moved on before this call landed. The client should
      // reload rather than retry.
      res.status(409).json({ code: 409, msg: err.message });
    } else {
      console.log(err);
      res
        .status(500)
        .json({ code: 500, msg: (err && err.message) || "An error occurred !" });
    }
  }

  validate(payload, schema) {
    const isValid = Joi.validate(payload, schema);
    if (isValid.error !== null) throw isValid.error;
    return isValid.value;
  }

  init() {
    const { require: needs } = this.permissions;

    const canView = needs("view_advance_request");
    const canCreate = needs("create_advance_request");
    const canCheckBalance = needs("view_old_balance_check");
    const canApprove = needs("approve_advance_request");
    const canPay = needs("pay_advance_request");
    const canEdit = needs("edit_advance_request");

    // ---------------------------------------------------------------- list

    router.get("/", canView, async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().integer().min(1).optional(),
          offset: Joi.number().integer().min(0).optional(),
          status: Joi.string().valid(STATUSES).optional(),
          distributor_code: Joi.number().optional(),
          outlet_id: Joi.number().optional(),
          created_by: Joi.number().optional(),
          invoice_number: Joi.string().max(100).allow(null, "").optional(),
          is_open: Joi.boolean().optional(),
          search: Joi.string().max(200).allow("").optional(),
          sort_by: Joi.string().valid(SORT_FIELDS).optional(),
          sort_dir: Joi.string().valid(["asc", "desc"]).optional(),
        };
        const query = this.validate(req.query, schema);

        const limit = Math.min(
          Number(query.limit) || DEFAULT_LIMIT,
          MAX_LIMIT
        );
        const offset = Number(query.offset) || 0;

        const data = await this.advanceRequestUsecase.getAll(
          {
            status: query.status,
            distributor_code: query.distributor_code,
            outlet_id: query.outlet_id,
            created_by: query.created_by,
            invoice_number: query.invoice_number,
            is_open: query.is_open,
            search: query.search,
          },
          limit,
          offset,
          query.sort_by,
          query.sort_dir
        );

        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ------------------------------------------------------------ read one

    router.get("/:id(\\d+)", canView, async (req, res) => {
      try {
        const data = await this.advanceRequestUsecase.getById(
          parseInt(req.params.id, 10)
        );
        if (!data) {
          return res.status(404).json({ code: 404, msg: "Not found" });
        }
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ------------------------------------------------------- A1 · create

    router.post("/", canCreate, async (req, res) => {
      try {
        const body = this.validate(req.body, a1Schema);

        // An outlet user's request belongs to their own store unless they
        // named one, the same default material requests use.
        const outlet_id = body.outlet_id ?? req.decoded.store_id ?? null;

        const id = await this.advanceRequestUsecase.create({
          invoice_number: body.invoice_number || null,
          distributor_code: body.distributor_code,
          amount: body.amount,
          reason: body.reason || null,
          outlet_id,
          created_by: req.decoded.employee_id,
        });

        res.status(201).json({ code: 200, advance_request_id: id });
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // --------------------------------------------------------- A1 · edit

    router.patch("/:id(\\d+)", canEdit, async (req, res) => {
      try {
        const body = this.validate(req.body, {
          invoice_number: Joi.string().max(100).allow(null, "").optional(),
          distributor_code: Joi.number().optional(),
          amount: Joi.number().greater(0).optional(),
          reason: Joi.string().max(500).allow(null, "").optional(),
        });

        const data = await this.advanceRequestUsecase.updateDetails(
          parseInt(req.params.id, 10),
          body,
          req.decoded.employee_id
        );

        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ------------------------------------------------ A1.1 · balance check

    router.patch(
      "/:id(\\d+)/balance-check",
      canCheckBalance,
      async (req, res) => {
        try {
          const body = this.validate(req.body, balanceCheckSchema);

          const data = await this.advanceRequestUsecase.balanceCheck(
            parseInt(req.params.id, 10),
            body,
            req.decoded.employee_id
          );

          res.json(data);
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    // ----------------------------------------------------- A2 · approval

    router.patch("/:id(\\d+)/approval", canApprove, async (req, res) => {
      try {
        const body = this.validate(req.body, approvalSchema);

        const data = await this.advanceRequestUsecase.approval(
          parseInt(req.params.id, 10),
          body,
          req.decoded.employee_id
        );

        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ------------------------------------------------------ A3 · payment

    router.patch("/:id(\\d+)/payment", canPay, async (req, res) => {
      try {
        const body = this.validate(req.body, paymentSchema);

        const data = await this.advanceRequestUsecase.payment(
          parseInt(req.params.id, 10),
          { ...body, payment_date: normaliseDate(body.payment_date) },
          req.decoded.employee_id
        );

        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ----------------------------------------------------------- documents

    router.post("/:id(\\d+)/documents", canCreate, async (req, res) => {
      try {
        const body = this.validate(req.body, documentSchema);

        const documents = await this.advanceRequestUsecase.addDocument(
          parseInt(req.params.id, 10),
          body.stage,
          body.file_url,
          req.decoded.employee_id
        );

        res.status(201).json({ code: 200, documents });
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (advanceRequestUsecase, permissions) => {
  return new AdvanceRequestRoutes(advanceRequestUsecase, permissions);
};
