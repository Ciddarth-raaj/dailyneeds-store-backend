const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class SalesDashboardRoutes {
  constructor(salesDashboardUsecase) {
    this.salesDashboardUsecase = salesDashboardUsecase;
    this.init();
  }

  init() {
    const parseCsvArray = (value) => {
      if (value == null || value === "") return [];
      if (Array.isArray(value)) return value;
      return String(value)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    };

    const dashboardFiltersSchema = Joi.object({
      branch_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      buyer_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      supplier_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      distributor_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      department_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      category_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      subcategory_ids: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      purchase_types: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
      chain_levels: Joi.alternatives()
        .try(Joi.array().items(Joi.string()), Joi.string())
        .optional(),
    });

    const normalizeDashboardFilters = (query = {}) => ({
      branch_ids: parseCsvArray(query.branch_ids),
      buyer_ids: parseCsvArray(query.buyer_ids),
      supplier_ids: parseCsvArray(query.supplier_ids),
      distributor_ids: parseCsvArray(query.distributor_ids),
      department_ids: parseCsvArray(query.department_ids),
      category_ids: parseCsvArray(query.category_ids),
      subcategory_ids: parseCsvArray(query.subcategory_ids),
      purchase_types: parseCsvArray(query.purchase_types),
      chain_levels: parseCsvArray(query.chain_levels),
    });

    router.get("/dashboard/meta", async (req, res) => {
      try {
        const schema = dashboardFiltersSchema.keys({
          as_of_date: Joi.date().required(),
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
        });
        const { error, value } = schema.validate(req.query);
        if (error) throw error;

        const filters = normalizeDashboardFilters(value);
        const result = await this.salesDashboardUsecase.getDashboardMeta(
          value.as_of_date,
          filters,
          { fromDate: value.from_date, toDate: value.to_date }
        );
        res.status(result.code === 200 ? 200 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/dashboard/filter-options", async (req, res) => {
      try {
        const schema = dashboardFiltersSchema.keys({
          as_of_date: Joi.date().required(),
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });
        const { error, value } = schema.validate(req.query);
        if (error) throw error;

        const filters = normalizeDashboardFilters(value);
        const result =
          await this.salesDashboardUsecase.getDashboardFilterOptions(
            value.as_of_date,
            filters,
            { fromDate: value.from_date, toDate: value.to_date }
          );
        res
          .status(
            result.code === 200 ? 200 : result.code === 422 ? 422 : 400
          )
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/dashboard/daily-totals", async (req, res) => {
      try {
        const schema = dashboardFiltersSchema.keys({
          as_of_date: Joi.date().required(),
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });
        const { error, value } = schema.validate(req.query);
        if (error) throw error;

        const filters = normalizeDashboardFilters(value);
        const result = await this.salesDashboardUsecase.getDashboardDailyTotals(
          value.as_of_date,
          filters,
          { fromDate: value.from_date, toDate: value.to_date }
        );
        res
          .status(
            result.code === 200 ? 200 : result.code === 422 ? 422 : 400
          )
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/dashboard/items", async (req, res) => {
      try {
        const schema = dashboardFiltersSchema.keys({
          date: Joi.date().required(),
          limit: Joi.number().integer().min(1).max(15000).default(5000),
          offset: Joi.number().integer().min(0).default(0),
        });
        const { error, value } = schema.validate(req.query);
        if (error) throw error;

        const filters = normalizeDashboardFilters(value);
        const result = await this.salesDashboardUsecase.getDashboardItems(
          value.date,
          filters,
          { limit: value.limit, offset: value.offset }
        );
        res.status(result.code === 200 ? 200 : 400).json(result);
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

module.exports = (salesDashboardUsecase) => {
  return new SalesDashboardRoutes(salesDashboardUsecase);
};
