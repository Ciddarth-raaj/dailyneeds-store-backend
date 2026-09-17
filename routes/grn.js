const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const P = require("../constants/grn_permissions");
const {
  VERIFICATION_START_DATE,
} = require("../constants/grn_verification");

const ignoreItemSchema = Joi.object({
  refno: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  sl_no: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  product_id: Joi.alternatives()
    .try(Joi.string(), Joi.number())
    .optional()
    .allow(null),
});
const ignoreSchema = Joi.object({
  items: Joi.array().items(ignoreItemSchema).min(1).required(),
});

function parseOptionalIsoDate(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, msg: `${label} must be YYYY-MM-DD` };
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, msg: `${label} is not a valid calendar date` };
  }
  return { ok: true, value: s };
}

class GrnRoutes {
  constructor(grnUsecase, permissions) {
    this.grnUsecase = grnUsecase;
    this.permissions = permissions;
    this.init();
  }

  init() {
    router.get("/list", async (req, res) => {
      try {
        const fromParsed = parseOptionalIsoDate(req.query.from_date, "from_date");
        const toParsed = parseOptionalIsoDate(req.query.to_date, "to_date");
        if (!fromParsed.ok) {
          res.status(400).json({ code: 400, msg: fromParsed.msg });
          res.end();
          return;
        }
        if (!toParsed.ok) {
          res.status(400).json({ code: 400, msg: toParsed.msg });
          res.end();
          return;
        }
        if (
          fromParsed.value &&
          toParsed.value &&
          fromParsed.value > toParsed.value
        ) {
          res.status(400).json({
            code: 400,
            msg: "from_date must be on or before to_date",
          });
          res.end();
          return;
        }

        const data = await this.grnUsecase.listGrnHeaders({
          from_date: fromParsed.value,
          to_date: toParsed.value,
        });
        res.json({
          code: 200,
          data,
          meta: {
            count: data.length,
            from_date: fromParsed.value ?? null,
            to_date: toParsed.value ?? null,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/detail", async (req, res) => {
      try {
        const refno =
          req.query.refno != null ? String(req.query.refno).trim() : "";
        if (!refno) {
          res.status(400).json({ code: 400, msg: "refno is required" });
          res.end();
          return;
        }

        const data = await this.grnUsecase.getGrnDetailByRefno(refno);
        if (!data) {
          res.status(404).json({ code: 404, msg: "GRN not found" });
          res.end();
          return;
        }

        res.json({
          code: 200,
          data,
          meta: {
            refno,
            item_count: data.items?.length ?? 0,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/issues", async (req, res) => {
      try {
        const fromParsed = parseOptionalIsoDate(req.query.from_date, "from_date");
        const toParsed = parseOptionalIsoDate(req.query.to_date, "to_date");
        if (!fromParsed.ok) {
          res.status(400).json({ code: 400, msg: fromParsed.msg });
          res.end();
          return;
        }
        if (!toParsed.ok) {
          res.status(400).json({ code: 400, msg: toParsed.msg });
          res.end();
          return;
        }
        if (
          fromParsed.value &&
          toParsed.value &&
          fromParsed.value > toParsed.value
        ) {
          res.status(400).json({
            code: 400,
            msg: "from_date must be on or before to_date",
          });
          res.end();
          return;
        }

        const data = await this.grnUsecase.listGrnIssues({
          from_date: fromParsed.value,
          to_date: toParsed.value,
        });
        res.json({
          code: 200,
          data,
          meta: {
            item_count: data.items?.length ?? 0,
            from_date: fromParsed.value ?? null,
            to_date: toParsed.value ?? null,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/issues/ignore", async (req, res) => {
      try {
        if (!req.decoded || req.decoded.user_type !== 2) {
          res.status(403).json({ code: 403, msg: "Only admins can ignore GRN issues" });
          res.end();
          return;
        }

        const isValid = Joi.validate(req.body, ignoreSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }

        const items = isValid.value.items.map((item) => ({
          refno: item.refno,
          sl_no: item.sl_no,
          product_id: item.product_id ?? null,
        }));
        const ignoredBy = req.decoded.employee_id ?? null;
        const result = await this.grnUsecase.ignoreGrnIssueItems(items, ignoredBy);
        res.json({ code: 200, ...result });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Puts an ignored line back on the Issue GRN list. Same admin gate and
    // payload as the ignore above; product_id is accepted but unused, since
    // (refno, sl_no) is the row's key.
    router.post("/issues/unignore", async (req, res) => {
      try {
        if (!req.decoded || req.decoded.user_type !== 2) {
          res.status(403).json({ code: 403, msg: "Only admins can un-ignore GRN issues" });
          res.end();
          return;
        }

        const isValid = Joi.validate(req.body, ignoreSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }

        const items = isValid.value.items.map((item) => ({
          refno: item.refno,
          sl_no: item.sl_no,
        }));
        const result = await this.grnUsecase.unignoreGrnIssueItems(items);
        res.json({ code: 200, ...result });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    /**
     * Sign this GRN off as checked and verified.
     *
     * THE APPROVER AND THE TIME ARE NOT INPUTS. The verifier is
     * `req.decoded.employee_id`, taken from the authenticated session that
     * global auth middleware already validated, and the time is written by
     * the database's CURRENT_TIMESTAMP default - a client cannot claim either
     * one. `verify_grn` is what lets the request through; `view_all_grn` only
     * ever said who may LOOK at a GRN.
     *
     * A repeat approval answers 200 with the ORIGINAL verifier and time and
     * `already_verified: true`, so a double click is harmless and the audit
     * record is never overwritten. A GRN dated before
     * VERIFICATION_START_DATE is refused with a 400: verification is not
     * retrospective, and the screens hiding the button is presentation, not
     * the boundary.
     */
    router.post(
      "/:refno/verify",
      this.permissions.require(P.VERIFY_GRN),
      async (req, res) => {
        try {
          const refno =
            req.params.refno != null ? String(req.params.refno).trim() : "";
          if (!refno) {
            res.status(400).json({ code: 400, msg: "refno is required" });
            res.end();
            return;
          }

          const verifiedBy = req.decoded?.employee_id ?? null;
          if (verifiedBy == null) {
            res.status(401).json({ code: 401, msg: "Unauthorized" });
            res.end();
            return;
          }

          const result = await this.grnUsecase.verifyGrn(refno, verifiedBy);
          if (!result) {
            res.status(404).json({ code: 404, msg: "GRN not found" });
            res.end();
            return;
          }
          if (result.out_of_scope) {
            res.status(400).json({
              code: 400,
              msg: `GRN verification applies to GRNs dated ${VERIFICATION_START_DATE} onwards; this GRN is older and cannot be verified`,
            });
            res.end();
            return;
          }

          res.json({
            code: 200,
            msg: result.already_verified
              ? "This GRN was already verified"
              : "GRN verified",
            data: result.verification,
            meta: { refno, already_verified: result.already_verified },
          });
        } catch (err) {
          respondError(res, err);
        }
        res.end();
      }
    );
  }

  getRouter() {
    return router;
  }
}

module.exports = (grnUsecase, permissions) => {
  return new GrnRoutes(grnUsecase, permissions);
};
