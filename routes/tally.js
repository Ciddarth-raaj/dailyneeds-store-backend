const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class TallyRoutes {
  constructor(tallyUsecase) {
    this.tallyUsecase = tallyUsecase;

    this.init();
  }

  init() {
    router.get("/purchase", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const purchase = await this.tallyUsecase.getPurchase(
          req.query.from_date,
          req.query.to_date
        );
        res.json(purchase);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ error: err.toString(), data: [] });
        } else {
          res.json({ error: "An error occurred !", data: [] });
        }
      }

      res.end();
    });
  }
  getRouter() {
    return router;
  }
}

module.exports = (tallyUsecase) => {
  return new TallyRoutes(tallyUsecase);
};
