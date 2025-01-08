const router = require("express").Router();
const Joi = require("@hapi/joi");

class AccountsEbookRoutes {
  constructor(accountsEbookUsecase) {
    this.accountsEbookUsecase = accountsEbookUsecase;
    this.init();
  }

  init() {
    router.post("/", async (req, res) => {
      try {
        const schema = {
          paytm_tid: Joi.string().required(),
          hdur: Joi.number().required(),
          hfpp: Joi.number().required(),
          sedc: Joi.number().required(),
          ppbl: Joi.number().required(),
          store_id: Joi.number().required(),
          date: Joi.date().required(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsEbookUsecase.createEbook(req.body);
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    router.put("/:id", async (req, res) => {
      try {
        const schema = {
          ebook_id: Joi.number().required(),
          paytm_tid: Joi.string().required(),
          hdur: Joi.number().required(),
          hfpp: Joi.number().required(),
          sedc: Joi.number().required(),
          ppbl: Joi.number().required(),
          store_id: Joi.number().required(),
          date: Joi.date().required(),
        };

        const ebook = { ...req.body, ebook_id: parseInt(req.params.id) };
        const isValid = Joi.validate(ebook, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsEbookUsecase.updateEbook(ebook);
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    router.delete("/:id", async (req, res) => {
      try {
        const schema = {
          id: Joi.number().required(),
        };

        const isValid = Joi.validate({ id: parseInt(req.params.id) }, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsEbookUsecase.deleteEbook(
          req.params.id
        );
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    router.get("/", async (req, res) => {
      try {
        const schema = {
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
          store_id: Joi.number().optional(),
        };

        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsEbookUsecase.getAllEbooks(req.query);
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    router.get("/:id", async (req, res) => {
      try {
        const schema = {
          id: Joi.number().required(),
        };

        const isValid = Joi.validate({ id: parseInt(req.params.id) }, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsEbookUsecase.getEbookById(
          req.params.id
        );
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    router.post("/bulk", async (req, res) => {
      try {
        const schema = {
          store_id: Joi.number().required(),
          date: Joi.date().required(),
          ebooks: Joi.array()
            .items(
              Joi.object({
                paytm_tid: Joi.string().required(),
                hdur: Joi.number().required(),
                hfpp: Joi.number().required(),
                sedc: Joi.number().required(),
                ppbl: Joi.number().required(),
              })
            )
            .required(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsEbookUsecase.bulkCreateEbook(
          req.body.ebooks,
          req.body.store_id,
          req.body.date
        );
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (accountsEbookUsecase) => {
  return new AccountsEbookRoutes(accountsEbookUsecase);
};
