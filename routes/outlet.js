const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class OutletRoutes {
  constructor(outletUsecase, permissions, ipRestriction) {
    this.outletUsecase = outletUsecase;
    this.permissions = permissions;
    this.ipRestriction = ipRestriction;

    this.init();
  }

  init() {
    const { require: needs } = this.permissions;

    router.get("/", async (req, res) => {
      try {
        const outlet = await this.outletUsecase.get();
        res.json(outlet);
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
    router.get("/outlet_id", async (req, res) => {
      try {
        const schema = {
          outlet_id: Joi.string().required(),
        };
        const outlet = req.query;
        // console.log({store: store})
        const isValid = Joi.validate(outlet, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.outletUsecase.getOutletById(outlet.outlet_id);
        // console.log({data: data});
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
    router.get("/id", async (req, res) => {
      try {
        const schema = {
          outlet_id: Joi.string().required(),
        };
        const outlet = req.query;

        const isValid = Joi.validate(outlet, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.outletUsecase.getOutletByOutletId(
          outlet.outlet_id
        );
        // console.log({data: data});
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
    router.post("/update-status", async (req, res) => {
      try {
        const schema = {
          outlet_id: Joi.number().required(),
          is_active: Joi.number().required(),
        };

        const outlet = req.body;
        const isValid = Joi.validate(outlet, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.outletUsecase.updateStatus(outlet);
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
    router.post("/update-outlet", async (req, res) => {
      try {
        const schema = {
          outlet_id: Joi.number().required(),
          outlet_details: Joi.object({
            outlet_name: Joi.string().required(),
            outlet_address: Joi.string().required(),
            outlet_phone: Joi.number()
              .min(100000000)
              .max(99999999999)
              .optional(),
            phone: Joi.string().allow(null).allow("").optional(),
            outlet_nickname: Joi.string().required(),
            telegram_username: Joi.string().allow(null).allow("").optional(),
            opening_cash: Joi.number().required(),
            gofrugal_id: Joi.string().allow(null).allow("").optional(),
            outlet_code: Joi.string().allow(null).allow("").optional(),
          }).optional(),
          budget: Joi.array().allow(null).allow("").optional(),
        };

        const outlet = req.body;
        const isValid = Joi.validate(outlet, schema);
        if (isValid.error !== null) {
          console.log({ error: isValid.error });
          throw isValid.error;
        }

        const response = await this.outletUsecase.updateOutletDetails(outlet);
        // console.log({code: code});
        res.json(response);
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

    router.post("/create", async (req, res) => {
      try {
        const schema = {
          outlet_details: Joi.object({
            outlet_name: Joi.string().required(),
            outlet_address: Joi.string().required(),
            outlet_phone: Joi.number()
              .min(100000000)
              .max(99999999999)
              .optional(),
            phone: Joi.string().allow(null).allow("").optional(),
            outlet_nickname: Joi.string().required(),
            telegram_username: Joi.string().allow(null).allow("").optional(),
            opening_cash: Joi.number().required(),
            gofrugal_id: Joi.string().allow(null).allow("").optional(),
            outlet_code: Joi.string().allow(null).allow("").optional(),
          }).optional(),
          budget: Joi.array().allow(null).allow("").required(),
        };
        const outlet = req.body;
        const isValid = Joi.validate(outlet, schema);

        if (isValid.error !== null) {
          throw isValid.error;
        }
        const response = await this.outletUsecase.create(outlet);

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

    // ------------------------------------------------------------------
    // Branch IP rule.
    //
    // Deliberately separate from /update-outlet and /create, which need no
    // token: the rule that decides where every employee of a branch may sign
    // in from must not be settable by anyone who can reach the outlet form.
    // These are protected by default (not in unProtectedRoutes) and gated on
    // the same permission as the per-user screen.
    // ------------------------------------------------------------------

    router.get(
      "/ip-restrictions",
      needs("manage_ip_restrictions"),
      async (req, res) => {
        try {
          const data = await this.outletUsecase.getIpRestrictions();
          res.json({ code: 200, data });
        } catch (err) {
          console.log(err);
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }
    );

    router.get(
      "/ip-restriction",
      needs("manage_ip_restrictions"),
      async (req, res) => {
        try {
          const schema = { outlet_id: Joi.number().integer().required() };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const data = await this.outletUsecase.getIpRestriction(
            req.query.outlet_id
          );
          if (!data) {
            res.status(404).json({ code: 404, msg: "Branch not found" });
            return;
          }
          res.json({ code: 200, data });
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.status(422).json({ code: 422, msg: err.message || err.toString() });
          } else {
            res.status(500).json({ code: 500, msg: "An error occurred !" });
          }
        }
      }
    );

    router.post(
      "/ip-restriction",
      needs("manage_ip_restrictions"),
      async (req, res) => {
        try {
          const schema = {
            outlet_id: Joi.number().integer().required(),
            allowed_ips: Joi.alternatives()
              .try(Joi.string().trim().allow(""), Joi.array().items(Joi.string()))
              .required(),
            ip_restriction_enabled: Joi.boolean().required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const data = await this.outletUsecase.updateIpRestriction(
            req.body.outlet_id,
            req.body.allowed_ips,
            req.body.ip_restriction_enabled
          );

          // Every employee of the branch shares this rule, and the middleware
          // caches each user's resolved policy for a minute — drop them all
          // so the change applies to their next request.
          if (this.ipRestriction && this.ipRestriction.invalidate) {
            this.ipRestriction.invalidate();
          }

          res.json(data);
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.status(422).json({ code: 422, msg: err.message || err.toString() });
          } else if (err.name === "NotFoundError") {
            res.status(404).json({ code: 404, msg: err.message });
          } else {
            res.status(500).json({ code: 500, msg: "An error occurred !" });
          }
        }
      }
    );
  }

  getRouter() {
    return router;
  }
}

module.exports = (outletUsecase, permissions, ipRestriction) => {
  return new OutletRoutes(outletUsecase, permissions, ipRestriction);
};
