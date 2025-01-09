const router = require("express").Router();
const Joi = require("@hapi/joi");

class AccountsRoutes {
  constructor(accountsUsecase) {
    this.accountsUsecase = accountsUsecase;
    this.init();
  }

  init() {
    router.get("/check-saved", async (req, res) => {
      try {
        const schema = {
          date: Joi.date().required(),
          store_id: Joi.string().required(),
        };

        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.checkSheetSaved(
          req.query.date,
          parseInt(req.query.store_id)
        );
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          console.log(err);
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    router.post("/save", async (req, res) => {
      try {
        const schema = {
          sheet_date: Joi.date().required(),
          store_id: Joi.number().required(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.saveAccount(req.body);
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

    router.delete("/save", async (req, res) => {
      try {
        const schema = {
          sheet_date: Joi.date().required(),
          store_id: Joi.number().required(),
        };

        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.deleteSavedAccount({
          sheet_date: req.query.sheet_date,
          store_id: parseInt(req.query.store_id),
        });
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

    router.post("/", async (req, res) => {
      try {
        const schema = {
          date: Joi.date().required(),
          total_sales: Joi.number().required(),
          cash_handover_1: Joi.number().default(0),
          cash_handover_2: Joi.number().default(0),
          cash_handover_5: Joi.number().default(0),
          cash_handover_10: Joi.number().default(0),
          cash_handover_20: Joi.number().default(0),
          cash_handover_50: Joi.number().default(0),
          cash_handover_100: Joi.number().default(0),
          cash_handover_200: Joi.number().default(0),
          cash_handover_500: Joi.number().default(0),
          card_sales: Joi.number().required(),
          loyalty: Joi.number().required(),
          sales_return: Joi.number().required(),
          cashier_id: Joi.number().required(),
          sales: Joi.array().items(
            Joi.object({
              person_type: Joi.number().required(),
              payment_type: Joi.number().required(),
              person_id: Joi.number().required(),
              description: Joi.string().required(),
              amount: Joi.number().required(),
              receipt_path: Joi.string().required(),
            })
          ),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        req.body.user_id = req.decoded.id;

        const result = await this.accountsUsecase.createAccount(req.body);
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
          accounts_id: Joi.number().required(),
          date: Joi.date().required(),
          total_sales: Joi.number().required(),
          cash_handover_1: Joi.number().default(0),
          cash_handover_2: Joi.number().default(0),
          cash_handover_5: Joi.number().default(0),
          cash_handover_10: Joi.number().default(0),
          cash_handover_20: Joi.number().default(0),
          cash_handover_50: Joi.number().default(0),
          cash_handover_100: Joi.number().default(0),
          cash_handover_200: Joi.number().default(0),
          cash_handover_500: Joi.number().default(0),
          card_sales: Joi.number().required(),
          loyalty: Joi.number().required(),
          sales_return: Joi.number().required(),
          cashier_id: Joi.number().required(),
          user_id: Joi.number().required(),
        };

        const account = { ...req.body, accounts_id: req.params.id };
        const isValid = Joi.validate(account, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.updateAccount(account);
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

        const result = await this.accountsUsecase.deleteAccount(req.params.id);
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

        const result = await this.accountsUsecase.getAllAccounts(req.query);
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

        const result = await this.accountsUsecase.getAccountById(req.params.id);
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

module.exports = (accountsUsecase) => {
  return new AccountsRoutes(accountsUsecase);
};
