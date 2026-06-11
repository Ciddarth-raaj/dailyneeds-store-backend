const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const bulkRowSchema = Joi.object({
  MPFD_CLASS_TYPE: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, "").optional(),
  MPFD_ID: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, "").optional(),
  MPFD_ITEM_CODE: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  MPFD_MARKUP_DOWN: Joi.string().allow(null, "").optional(),
  MPFD_PRICE_PARAMETER: Joi.string().allow(null, "").optional(),
  MPFD_VALUE: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, "").optional(),
  MPFD_AMT_PERC: Joi.string().allow(null, "").optional(),
  MPFD_ROUNDOFF_TYPE: Joi.string().allow(null, "").optional(),
  MPFD_ROUNDOFF_VALUE: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, "").optional(),
  MPFD_STATUS: Joi.string().allow(null, "").optional(),
  MPFD_MRP_PRICE_PARAM: Joi.string().allow(null, "").optional(),
  MPFD_MRP_VALUE: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null, "").optional(),
  MPFD_MRP_AMT_PERC: Joi.string().allow(null, "").optional(),
  PRODUCT_NAME: Joi.string().allow(null, "").optional(),
});

const bulkSchema = Joi.array().items(bulkRowSchema).min(1).required();

class ItemMarkupdownRoutes {
  constructor(itemMarkupdownUsecase) {
    this.itemMarkupdownUsecase = itemMarkupdownUsecase;
    this.init();
  }

  init() {
    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }

        const result = await this.itemMarkupdownUsecase.bulkReplace(isValid.value);
        if (result.code === 400) {
          res.status(400).json(result);
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

module.exports = (itemMarkupdownUsecase) => {
  return new ItemMarkupdownRoutes(itemMarkupdownUsecase);
};
