const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PurchaseReturnRoutes {
  constructor(purchaseReturnUsecase) {
    this.purchaseReturnUsecase = purchaseReturnUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.purchaseReturnUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/by-distributor/:distributor_id", async (req, res) => {
      try {
        const { distributor_id } = req.params;
        const purchase_acknowledgement_id = req.query.purchase_acknowledgement_id != null
          ? parseInt(req.query.purchase_acknowledgement_id, 10)
          : null;
        const list = await this.purchaseReturnUsecase.getOpenByDistributorId(distributor_id, isNaN(purchase_acknowledgement_id) ? null : purchase_acknowledgement_id);
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:mprh_pr_no", async (req, res) => {
      try {
        const { mprh_pr_no } = req.params;
        const pr = await this.purchaseReturnUsecase.getById(mprh_pr_no);
        if (!pr) {
          res.status(404).json({ code: 404, msg: "Purchase return not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: pr });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const extraSchema = Joi.object({
      mprh_pr_no: Joi.string().required().max(50),
      no_of_boxes: Joi.number().integer().min(0).optional().default(0),
      status: Joi.string().valid("open", "done").optional().default("open"),
      purchase_acknowledgement_id: Joi.number().integer().min(1).optional().allow(null)
    });

    router.post("/extra", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, extraSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const created_by = req.decoded && req.decoded.employee_id ? req.decoded.employee_id : null;
        const result = await this.purchaseReturnUsecase.createExtra({ ...req.body, created_by });
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/extra/:mprh_pr_no", async (req, res) => {
      try {
        const updateSchema = Joi.object({
          no_of_boxes: Joi.number().integer().min(0).optional(),
          status: Joi.string().valid("open", "done").optional(),
          purchase_acknowledgement_id: Joi.number().integer().min(1).optional().allow(null)
        });
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const { mprh_pr_no } = req.params;
        const result = await this.purchaseReturnUsecase.updateExtra(mprh_pr_no, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (purchaseReturnUsecase) => {
  return new PurchaseReturnRoutes(purchaseReturnUsecase);
};
