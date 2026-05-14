const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const GSTIN_PATTERN = /^[0-9A-Z]{15}$/;

class GstRoutes {
  constructor(gstUsecase) {
    this.gstUsecase = gstUsecase;
    this.init();
  }

  init() {
    router.get("/vendors", async (req, res) => {
      try {
        const payload = await this.gstUsecase.getAllVendors();
        res.json(payload);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/search", async (req, res) => {
      try {
        const schema = {
          gstin: Joi.string()
            .trim()
            .uppercase()
            .length(15)
            .regex(GSTIN_PATTERN)
            .required(),
        };

        const isValid = Joi.validate(
          {
            gstin: req.body.gstin,
          },
          schema
        );

        if (isValid.error !== null) {
          throw isValid.error;
        }

        const payload = await this.gstUsecase.searchGstin(isValid.value.gstin);

        res.json(payload);
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

module.exports = (gstUsecase) => {
  return new GstRoutes(gstUsecase);
};
