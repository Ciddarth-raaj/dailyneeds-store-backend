const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const numField = () =>
  Joi.alternatives().try(Joi.number(), Joi.string()).allow(null, "");

const rowSchema = Joi.object({
  MOH_OFFER_ID: numField().required(),
  MOH_OFFER_NAME: Joi.string().allow(null, "").optional(),
  MOH_OFFER_FAMILY_ID: numField().optional(),
  MOH_OFFER_TYPEID: numField().optional(),
  MOH_OFFER_STATUS: numField().optional(),
  MOH_OFFER_GET_CONFIRM: numField().optional(),
  MOH_OFFER_TIER_ID: numField().optional(),
  MOH_OFFER_PERIOD: numField().optional(),
  MOH_OFFER_HAPPY_DAYS: numField().optional(),
  MOH_OFFER_HAPPY_HOURS: numField().optional(),
  MOH_OFFER_FIRST_N_CUSTOMERS: numField().optional(),
  MOH_OFFER_ST_DATE: Joi.alternatives()
    .try(Joi.date(), Joi.string())
    .allow(null, "")
    .optional(),
  MOH_OFFER_END_DATE: Joi.alternatives()
    .try(Joi.date(), Joi.string())
    .allow(null, "")
    .optional(),
  MOH_OFFER_HQ_ID: numField().optional(),
  MOH_OFFER_NTH_BILL: numField().optional(),
  TS: Joi.alternatives().try(Joi.date(), Joi.string()).allow(null, "").optional(),
  TSID: numField().optional(),
  RETAIL_OUTLET_ID: numField().required(),
  MOH_VERTICAL_ID: numField().optional(),
  MOH_OFFER_CUST_TYPE: numField().optional(),
  TIMESTAMP: Joi.string().allow(null, "").optional(),
  MOH_ALLOW_SPAN: numField().optional(),
  MOH_OFFER_ON_NEXTBILL: numField().optional(),
  MOH_LOYALTY_CARD_MUST: numField().optional(),
  HQ_TIMESTAMP_ID: numField().optional(),
  MOH_OFFER_ON_EACHITEM: numField().optional(),
  MOH_FIRST_TIME_OFFER: numField().optional(),
  MOH_OFFER_BASEDON_MRP: numField().optional(),
  MOH_HAPPY_HOURS_BASEDON: numField().optional(),
  MOH_OFFER_ON_ITEMUOM: numField().optional(),
  MOH_BATCH_OFFER: numField().optional(),
  MOH_OVERRIDE_DUPLICATE: numField().optional(),
  MOH_BLOCK_RETURN: numField().optional(),
  MOH_CUST_SPECIFIC_OFFER: numField().optional(),
  MOH_LOYALTY_POINT: numField().optional(),
  MOH_OFFER_ST_DAY: numField().optional(),
  MOH_OFFER_END_DAY: numField().optional(),
  MOH_OFFER_SALES_PERIOD: numField().optional(),
  MOH_OFFER_SALES_ST_DT: Joi.alternatives()
    .try(Joi.date(), Joi.string())
    .allow(null, "")
    .optional(),
  MOH_OFFER_SALES_END_DT: Joi.alternatives()
    .try(Joi.date(), Joi.string())
    .allow(null, "")
    .optional(),
  MOH_ALLOW_MAX_QTY: numField().optional(),
});

const bulkSchema = Joi.array().items(rowSchema).min(1).required();

const productRowSchema = Joi.object({
  MOSP_OFFER_ID: numField().required(),
  MOSP_SUB_ID: numField().optional(),
  MOSP_CATEGORY_ID: numField().optional(),
  MOSP_ITEM_CODE: numField().required(),
  TS: Joi.alternatives().try(Joi.date(), Joi.string()).allow(null, "").optional(),
  TSID: numField().optional(),
  RETAIL_OUTLET_ID: numField().required(),
  TIMESTAMP: Joi.string().allow(null, "").optional(),
  HQ_TIMESTAMP_ID: numField().optional(),
});

const productBulkSchema = Joi.array().items(productRowSchema).min(1).required();

const issueRowSchema = Joi.object({
  MOI_OFFER_ID: numField().required(),
  MOI_OFFER_SL_NO: numField().optional(),
  MOI_OFFER_ON: Joi.string().allow(null, "").optional(),
  MOI_OFFER_SATISFIED: Joi.string().allow(null, "").optional(),
  MOI_OFFER_TYPE: numField().optional(),
  MOI_ITEM_CODE: numField().optional(),
  MOI_OFFER_VALUE: numField().optional(),
  MOI_OFFER_EXTRA_CONDITION: numField().optional(),
  MOI_OFFER_EXTRA_CONDITION_QTY: numField().optional(),
  TS: Joi.alternatives().try(Joi.date(), Joi.string()).allow(null, "").optional(),
  TSID: numField().optional(),
  RETAIL_OUTLET_ID: numField().required(),
  TIMESTAMP: Joi.string().allow(null, "").optional(),
  HQ_TIMESTAMP_ID: numField().optional(),
  MOI_CONV_TYPE: Joi.string().allow(null, "").optional(),
  MOI_CONV_FACTOR: numField().optional(),
  MOI_BATCH_NO: Joi.string().allow(null, "").optional(),
});

const issueBulkSchema = Joi.array().items(issueRowSchema).min(1).required();

class HqOffersRoutes {
  constructor(hqOffersUsecase) {
    this.hqOffersUsecase = hqOffersUsecase;
    this.init();
  }

  init() {
    router.get("/hdr", async (req, res) => {
      try {
        const schema = Joi.object({
          limit: Joi.alternatives()
            .try(Joi.number().integer().min(1).max(500), Joi.string().valid("all"))
            .optional(),
          offset: Joi.number().integer().min(0).optional(),
          sort_by: Joi.string().optional(),
          sort_dir: Joi.string().valid("asc", "desc").optional(),
          status: Joi.string().valid("active", "inactive").optional(),
          filter: Joi.alternatives().try(Joi.string(), Joi.object()).optional(),
        });
        const { error, value } = schema.validate(req.query);
        if (error) {
          res.status(400).json({ code: 400, msg: error.message });
          res.end();
          return;
        }

        const result =
          value.limit === "all"
            ? await this.hqOffersUsecase.listHdrAll({
                sortBy: value.sort_by,
                sortDir: value.sort_dir,
                status: value.status,
                filterModel: value.filter,
              })
            : await this.hqOffersUsecase.listHdr({
                limit: value.limit ?? 20,
                offset: value.offset ?? 0,
                sortBy: value.sort_by,
                sortDir: value.sort_dir,
                status: value.status,
                filterModel: value.filter,
              });
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/products", async (req, res) => {
      try {
        const schema = Joi.object({
          limit: Joi.alternatives()
            .try(Joi.number().integer().min(1).max(500), Joi.string().valid("all"))
            .optional(),
          offset: Joi.number().integer().min(0).optional(),
          sort_by: Joi.string().optional(),
          sort_dir: Joi.string().valid("asc", "desc").optional(),
          status: Joi.string().valid("active", "inactive").optional(),
          group_by: Joi.string().valid("distributor", "buyer").optional(),
          filter: Joi.alternatives().try(Joi.string(), Joi.object()).optional(),
        });
        const { error, value } = schema.validate(req.query);
        if (error) {
          res.status(400).json({ code: 400, msg: error.message });
          res.end();
          return;
        }

        const result =
          value.limit === "all"
            ? await this.hqOffersUsecase.listProductLinesAll({
                sortBy: value.sort_by,
                sortDir: value.sort_dir,
                status: value.status,
                filterModel: value.filter,
                groupBy: value.group_by,
              })
            : await this.hqOffersUsecase.listProductLines({
                limit: value.limit ?? 20,
                offset: value.offset ?? 0,
                sortBy: value.sort_by,
                sortDir: value.sort_dir,
                status: value.status,
                filterModel: value.filter,
                groupBy: value.group_by,
              });
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/hdr/:moh_offer_hq_id", async (req, res) => {
      try {
        const moh_offer_hq_id = Number(req.params.moh_offer_hq_id);
        if (!Number.isFinite(moh_offer_hq_id)) {
          res.status(400).json({
            code: 400,
            msg: "moh_offer_hq_id must be a valid number",
          });
          res.end();
          return;
        }

        const result = await this.hqOffersUsecase.getOfferDetailByHqId(moh_offer_hq_id);
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

    router.get("/hdr/:moh_offer_id/:retail_outlet_id", async (req, res) => {
      try {
        const moh_offer_id = Number(req.params.moh_offer_id);
        const retail_outlet_id = Number(req.params.retail_outlet_id);
        if (!Number.isFinite(moh_offer_id) || !Number.isFinite(retail_outlet_id)) {
          res.status(400).json({
            code: 400,
            msg: "moh_offer_id and retail_outlet_id must be valid numbers",
          });
          res.end();
          return;
        }

        const result = await this.hqOffersUsecase.getOfferDetail(
          moh_offer_id,
          retail_outlet_id
        );
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

    router.post("/hdr", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, rowSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.hqOffersUsecase.insert(isValid.value);
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

    router.post("/hdr/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.hqOffersUsecase.bulkInsert(isValid.value);
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

    router.post("/products", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, productRowSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.hqOffersUsecase.insertProduct(isValid.value);
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

    router.post("/products/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, productBulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.hqOffersUsecase.bulkInsertProducts(isValid.value);
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

    router.post("/issue", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, issueRowSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.hqOffersUsecase.insertIssue(isValid.value);
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

    router.post("/issue/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, issueBulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.hqOffersUsecase.bulkInsertIssues(isValid.value);
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

module.exports = (hqOffersUsecase) => {
  return new HqOffersRoutes(hqOffersUsecase);
};
