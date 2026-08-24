const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const bulkRowSchema = Joi.object({
  Outlet_ID: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  Outlet_Name: Joi.string().allow("", null),
  Item_Code: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  Item_Name: Joi.string().allow("", null),
  Batch_No: Joi.string().allow("", null),
  Purchase_Price: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  Landing_Cost: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  Old_MRP: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  New_MRP: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  Old_Selling_Price: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  New_Selling_Price: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
});

const bulkSchema = Joi.array().items(bulkRowSchema).min(1).required();

class PriceCheckerRoutes {
  constructor(priceCheckerUsecase) {
    this.priceCheckerUsecase = priceCheckerUsecase;
    this.init();
  }

  init() {
    router.get("/items-by-product", async (req, res) => {
      try {
        const raw =
          req.query.product_id != null ? String(req.query.product_id).trim() : "";
        const productId = parseInt(raw, 10);
        if (!raw || !Number.isFinite(productId)) {
          res.status(400).json({ code: 400, msg: "product_id is required" });
          res.end();
          return;
        }

        const data =
          await this.priceCheckerUsecase.listGroupedItemsByProductId(productId);
        res.json({
          code: 200,
          data,
          meta: {
            product_id: productId,
            count: data?.length ?? 0,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/", async (req, res) => {
      try {
        const result = await this.priceCheckerUsecase.listForClient();
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }

        const rows = isValid.value.map((r) => ({
          outlet_id: r.Outlet_ID,
          outlet_name: r.Outlet_Name,
          item_code: r.Item_Code,
          item_name: r.Item_Name,
          batch_no: r.Batch_No,
          purchase_price: r.Purchase_Price,
          landing_cost: r.Landing_Cost,
          old_mrp: r.Old_MRP,
          new_mrp: r.New_MRP,
          old_selling_price: r.Old_Selling_Price,
          new_selling_price: r.New_Selling_Price,
        }));

        const uploadedBy = req.decoded?.employee_id ?? null;
        const result = await this.priceCheckerUsecase.bulkReplace(rows, uploadedBy);

        if (result.code === 400) {
          res.status(400).json(result);
          res.end();
          return;
        }

        res.status(202).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/jobs/:jobId/status", async (req, res) => {
      try {
        const result = await this.priceCheckerUsecase.getJobStatus(req.params.jobId);
        if (result.code === 404) {
          res.status(404).json(result);
          res.end();
          return;
        }
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

module.exports = (priceCheckerUsecase) => new PriceCheckerRoutes(priceCheckerUsecase);
