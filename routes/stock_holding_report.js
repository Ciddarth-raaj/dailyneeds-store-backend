const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class StockHoldingReportRoutes {
  constructor(stockHoldingReportUsecase) {
    this.stockHoldingReportUsecase = stockHoldingReportUsecase;
    this.init();
  }

  init() {
    const itemSchema = Joi.object({
      product_id: Joi.number().integer().required(),
      outlet_id: Joi.number().integer().required(),
      current_stock: Joi.number().required(),
      current_stock_value: Joi.number().required(),
      stock_duration: Joi.alternatives()
        .try(Joi.number().integer(), Joi.string())
        .allow(null)
        .optional(),
      status: Joi.string().max(100).allow(null, "").optional(),
    });

    const createSchema = Joi.object({
      report_name: Joi.string().max(255).required(),
      date: Joi.date().required(),
      items: Joi.array().items(itemSchema).optional(),
    });

    const appendItemsSchema = Joi.object({
      items: Joi.array().items(itemSchema).min(1).required(),
      finalize: Joi.boolean().default(false),
    });

    const paginationSchema = Joi.object({
      limit: Joi.number().integer().min(1).max(5000).default(5000),
      offset: Joi.number().integer().min(0).default(0),
    });

    router.post("/", async (req, res) => {
      try {
        const { error, value } = createSchema.validate(req.body);
        if (error) throw error;

        value.created_by = req.decoded?.employee_id ?? null;

        const result =
          value.items?.length > 0
            ? await this.stockHoldingReportUsecase.create(value)
            : await this.stockHoldingReportUsecase.createHeader(value);
        res.status(result.code === 200 ? 201 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/:id(\\d+)/items", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) throw new Error("Invalid stock holding report id");

        const { error, value } = appendItemsSchema.validate(req.body);
        if (error) throw error;

        const result = await this.stockHoldingReportUsecase.appendItems(
          id,
          value.items,
          { finalize: value.finalize }
        );
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/sync", async (req, res) => {
      try {
        const created_by = req.decoded?.employee_id ?? null;
        const result = await this.stockHoldingReportUsecase.syncFromDeliumApi({
          created_by,
        });
        res
          .status(result.code === 200 ? 200 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/", async (_req, res) => {
      try {
        const result = await this.stockHoldingReportUsecase.getAllReports();
        res.status(result.code === 200 ? 200 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/latest/items", async (req, res) => {
      try {
        const latestSchema = Joi.object({
          date: Joi.date().required(),
          report_id: Joi.number().integer().optional(),
          limit: Joi.number().integer().min(1).max(15000).default(15000),
          offset: Joi.number().integer().min(0).default(0),
        });
        const { error, value } = latestSchema.validate(req.query);
        if (error) throw error;

        const result = await this.stockHoldingReportUsecase.getLatestItemsPage(
          value.date,
          value.limit,
          value.offset,
          value.report_id ?? null
        );
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/latest", async (req, res) => {
      try {
        const latestSchema = Joi.object({
          date: Joi.date().required(),
        });
        const { error, value } = latestSchema.validate(req.query);
        if (error) throw error;

        const result = await this.stockHoldingReportUsecase.getReportById(
          value.date,
          { includeItems: false }
        );
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:id(\\d+)/items", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) throw new Error("Invalid stock holding report id");

        const { error, value } = paginationSchema.validate(req.query);
        if (error) throw error;

        const result = await this.stockHoldingReportUsecase.getById(id, {
          includeItems: true,
          limit: value.limit,
          offset: value.offset,
        });
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) throw new Error("Invalid stock holding report id");

        const result = await this.stockHoldingReportUsecase.getById(id, {
          includeItems: false,
        });
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) throw new Error("Invalid stock holding report id");

        const result = await this.stockHoldingReportUsecase.delete(id);
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
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

module.exports = (stockHoldingReportUsecase) => {
  return new StockHoldingReportRoutes(stockHoldingReportUsecase);
};
