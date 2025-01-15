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
              receipt_path: Joi.string().allow("").allow(null).optional(),
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
          sales: Joi.array().items(
            Joi.object({
              sales_id: Joi.number().allow("").allow(null).optional(),
              person_type: Joi.number().required(),
              payment_type: Joi.number().required(),
              person_id: Joi.number().required(),
              description: Joi.string().required(),
              amount: Joi.number().required(),
              receipt_path: Joi.string().allow("").allow(null).optional(),
            })
          ),
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

    // Warehouse Sales Routes
    router.post("/warehouse-sales", async (req, res) => {
      try {
        const schema = Joi.object({
          person_type: Joi.number().required(),
          payment_type: Joi.number().required(),
          person_id: Joi.number().required(),
          description: Joi.string().required(),
          amount: Joi.number().required(),
          receipt_path: Joi.string().allow("").allow(null).optional(),
          date: Joi.date().required(),
        });

        const isValid = schema.validate(req.body);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.createWarehouseSale(req.body);
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

    router.put("/warehouse-sales/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          sales_id: Joi.number().required(),
          person_type: Joi.number().required(),
          payment_type: Joi.number().required(),
          person_id: Joi.number().required(),
          description: Joi.string().required(),
          amount: Joi.number().required(),
          receipt_path: Joi.string().allow("").allow(null).optional(),
          date: Joi.date().required(),
        });

        const sale = { ...req.body, sales_id: parseInt(req.params.id) };
        const isValid = schema.validate(sale);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.updateWarehouseSale(sale);
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

    router.delete("/warehouse-sales/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const isValid = schema.validate({ id: parseInt(req.params.id) });
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.deleteWarehouseSale(
          parseInt(req.params.id)
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

    router.get("/warehouse-sales", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getWarehouseSales(req.query);
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

    router.get("/warehouse-sales/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const isValid = schema.validate({ id: parseInt(req.params.id) });
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getWarehouseSaleById(
          parseInt(req.params.id)
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

    // Warehouse Cash Denomination Routes
    router.post("/warehouse-cash-denomination", async (req, res) => {
      try {
        const schema = Joi.object({
          cash_handover_1: Joi.number().required(),
          cash_handover_2: Joi.number().required(),
          cash_handover_5: Joi.number().required(),
          cash_handover_10: Joi.number().required(),
          cash_handover_20: Joi.number().required(),
          cash_handover_50: Joi.number().required(),
          cash_handover_100: Joi.number().required(),
          cash_handover_200: Joi.number().required(),
          cash_handover_500: Joi.number().required(),
          date: Joi.date().required(),
        });

        const isValid = schema.validate(req.body);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result =
          await this.accountsUsecase.createWarehouseCashDenomination(req.body);
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

    router.put("/warehouse-cash-denomination/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          cash_denomination_id: Joi.number().required(),
          cash_handover_1: Joi.number().required(),
          cash_handover_2: Joi.number().required(),
          cash_handover_5: Joi.number().required(),
          cash_handover_10: Joi.number().required(),
          cash_handover_20: Joi.number().required(),
          cash_handover_50: Joi.number().required(),
          cash_handover_100: Joi.number().required(),
          cash_handover_200: Joi.number().required(),
          cash_handover_500: Joi.number().required(),
          date: Joi.date().required(),
        });

        const denomination = {
          ...req.body,
          cash_denomination_id: parseInt(req.params.id),
        };
        const isValid = schema.validate(denomination);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result =
          await this.accountsUsecase.updateWarehouseCashDenomination(
            denomination
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

    router.delete("/warehouse-cash-denomination/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const isValid = schema.validate({ id: parseInt(req.params.id) });
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result =
          await this.accountsUsecase.deleteWarehouseCashDenomination(
            parseInt(req.params.id)
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

    router.get("/warehouse-cash-denomination", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getWarehouseCashDenominations(
          req.query
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

    router.get("/warehouse-cash-denomination/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const isValid = schema.validate({ id: parseInt(req.params.id) });
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result =
          await this.accountsUsecase.getWarehouseCashDenominationById(
            parseInt(req.params.id)
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

    // Get all outlets cash handover
    router.get("/outlets-cash-handover", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getAllOutletsCashHandover(
          req.query
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

    router.post("/warehouse-starting-cash", async (req, res) => {
      try {
        const schema = Joi.object({
          starting_cash: Joi.number().required(),
          date: Joi.date().required(),
          can_carry_forward: Joi.boolean().allow(null).optional(),
        });

        const isValid = schema.validate(req.body);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.addStartingCash(req.body);
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

    router.get("/warehouse-starting-cash", async (req, res) => {
      try {
        const schema = Joi.object({
          date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getStartingCash(
          req.query.date
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

    router.get("/saved-account", async (req, res) => {
      try {
        const schema = Joi.object({
          date: Joi.date().required(),
          store_id: Joi.number().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getSavedAccount(
          req.query.date,
          parseInt(req.query.store_id)
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

    router.get("/sales-by-outlet", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.accountsUsecase.getSalesByOutlet(req.query);
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
