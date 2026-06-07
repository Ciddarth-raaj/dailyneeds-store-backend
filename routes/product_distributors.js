const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class ProductDistributorsRoutes {
  constructor(productDistributorsUsecase) {
    this.productDistributorsUsecase = productDistributorsUsecase;
    this.init();
  }

  init() {
    const upsertSchema = Joi.object({
      MDM_DIST_CODE: Joi.alternatives()
        .try(Joi.string(), Joi.number())
        .required(),
      buyer_id: Joi.number().integer().allow(null).optional(),
    });

    const bulkUpsertSchema = Joi.object({
      items: Joi.array().items(upsertSchema).min(1).max(2000).required(),
    });

    const hqImportItemSchema = Joi.object({
      MDM_DIST_CODE: Joi.alternatives()
        .try(Joi.string(), Joi.number())
        .required(),
      MDM_DIST_NAME: Joi.string().allow(null, "").optional(),
      MDM_SHORT_NAME: Joi.string().allow(null, "").optional(),
      CID: Joi.string().trim().min(1).required(),
      MDM_TAG: Joi.string().allow(null, "").optional(),
    });

    const hqImportSchema = Joi.array().items(hqImportItemSchema).required();

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, upsertSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productDistributorsUsecase.upsertBuyerMap(
          req.body
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/bulk/test", async (req, res) => {
      try {
        // const isValid = Joi.validate(req.body, bulkUpsertSchema);
        // if (isValid.error) {
        //   res.status(400).json({ code: 400, msg: isValid.error.message });
        //   res.end();
        //   return;
        // }
        console.log(req.body);
        const result = await this.productDistributorsUsecase.bulkUpsertBuyerMap(
          req.body
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkUpsertSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productDistributorsUsecase.bulkUpsertBuyerMap(
          req.body.items
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/bulk/hq-import", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, hqImportSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productDistributorsUsecase.bulkHqImport(
          isValid.value
        );
        res.json(result);
      } catch (err) {
        if (err.statusCode) {
          res
            .status(err.statusCode)
            .json({ code: err.statusCode, msg: err.message });
        } else {
          respondError(res, err);
        }
      }
      res.end();
    });

    router.get("/", async (req, res) => {
      try {
        const list = await this.productDistributorsUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:MDM_DIST_CODE", async (req, res) => {
      try {
        const { MDM_DIST_CODE } = req.params;
        const row = await this.productDistributorsUsecase.getByCode(
          MDM_DIST_CODE
        );
        if (!row) {
          res.status(404).json({ code: 404, msg: "Distributor not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:MDM_DIST_CODE", async (req, res) => {
      try {
        const { MDM_DIST_CODE } = req.params;
        const result = await this.productDistributorsUsecase.delete(
          MDM_DIST_CODE
        );
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

module.exports = (productDistributorsUsecase) => {
  return new ProductDistributorsRoutes(productDistributorsUsecase);
};
