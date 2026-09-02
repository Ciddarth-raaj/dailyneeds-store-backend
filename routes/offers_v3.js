const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const OFFER_TYPES = ["percentage", "flat", "fixed_price"];
const ITEM_STATUSES = ["active", "inactive"];
const BATCH_STATUSES = ["active", "zero_stock_flagged", "batch_zero_ended", "inactive"];

function getCreatedBy(req) {
  return req.decoded && req.decoded.employee_id ? req.decoded.employee_id : null;
}

function sendResult(res, result) {
  if (result && result.code === 400) {
    res.status(400).json(result);
  } else if (result && result.code === 404) {
    res.status(404).json(result);
  } else {
    res.json(result);
  }
}

const itemCreateSchema = Joi.object({
  item_code: Joi.number().integer().required(),
  offer_type: Joi.string().valid(...OFFER_TYPES).required(),
  value: Joi.number().min(0).required(),
  threshold_qty: Joi.number().integer().min(0).required(),
});

const itemUpdateSchema = Joi.object({
  offer_type: Joi.string().valid(...OFFER_TYPES).optional(),
  value: Joi.number().min(0).optional(),
  threshold_qty: Joi.number().integer().min(0).optional(),
  status: Joi.string().valid(...ITEM_STATUSES).optional(),
}).min(1);

const batchCreateSchema = Joi.object({
  item_code: Joi.number().integer().required(),
  outlet_id: Joi.number().integer().required(),
  batch_no: Joi.string().trim().min(1).required(),
  offer_type: Joi.string().valid(...OFFER_TYPES).required(),
  value: Joi.number().min(0).required(),
});

const batchUpdateSchema = Joi.object({
  offer_type: Joi.string().valid(...OFFER_TYPES).optional(),
  value: Joi.number().min(0).optional(),
  status: Joi.string().valid(...BATCH_STATUSES).optional(),
}).min(1);

// Row-level fields are intentionally lenient (allow blank/null/missing)
// rather than required: a bad or incomplete row in a large upload should be
// skipped by the usecase layer, not fail the entire batch.
const uploadCellSchema = Joi.alternatives(Joi.number(), Joi.string()).allow("", null).optional();

const stockUploadRowSchema = Joi.object({
  item_code: uploadCellSchema,
  outlet: uploadCellSchema,
  batch_no: uploadCellSchema,
  stock_qty: uploadCellSchema,
});
const stockUploadSchema = Joi.array().items(stockUploadRowSchema).min(1);

const priceUploadRowSchema = Joi.object({
  item_code: uploadCellSchema,
  outlet: uploadCellSchema,
  batch_no: uploadCellSchema,
  mrp: uploadCellSchema,
  selling_price: uploadCellSchema,
  landing_cost: uploadCellSchema,
});
const priceUploadSchema = Joi.array().items(priceUploadRowSchema).min(1);

const importRowSchema = Joi.object({
  scope: Joi.string().allow("", null).optional(),
  item_code: uploadCellSchema,
  outlet: uploadCellSchema,
  batch_no: uploadCellSchema,
  offer_type: Joi.string().allow("", null).optional(),
  value: uploadCellSchema,
  threshold_qty: uploadCellSchema,
  status: Joi.string().allow("", null).optional(),
});
const importSchema = Joi.array().items(importRowSchema).min(1);

class OffersV3Routes {
  constructor(offersV3Usecase) {
    this.offersV3Usecase = offersV3Usecase;
    this.init();
  }

  init() {
    // Item-level offers
    router.get("/items", async (req, res) => {
      try {
        const data = await this.offersV3Usecase.listItemOffers({ status: req.query.status });
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/items/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const row = await this.offersV3Usecase.getItemOfferById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Offer not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/items", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, itemCreateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.createItemOffer(isValid.value, getCreatedBy(req));
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/items/:id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, itemUpdateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.id, 10);
        const result = await this.offersV3Usecase.updateItemOffer(id, isValid.value);
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Batch-specific offers
    router.get("/batches", async (req, res) => {
      try {
        const data = await this.offersV3Usecase.listBatchOffers({
          status: req.query.status,
          item_code: req.query.item_code ? parseInt(req.query.item_code, 10) : undefined,
          outlet_id: req.query.outlet_id ? parseInt(req.query.outlet_id, 10) : undefined,
        });
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/batches/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const row = await this.offersV3Usecase.getBatchOfferById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Offer not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/batches", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, batchCreateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.createBatchOffer(isValid.value, getCreatedBy(req));
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/batches/:id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, batchUpdateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.id, 10);
        const result = await this.offersV3Usecase.updateBatchOffer(id, isValid.value);
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/batches/:id/end", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const result = await this.offersV3Usecase.updateBatchOffer(id, { status: "batch_zero_ended" });
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Batch stock upload
    router.post("/stock-upload", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, stockUploadSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.processStockUpload(isValid.value, getCreatedBy(req));
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Batch price upload (Price Checker-style export; Old_MRP/Old_Selling_Price
    // resolved to mrp/selling_price by the caller per the fixed mapping rule)
    router.post("/price-upload", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, priceUploadSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.processPriceUpload(isValid.value, getCreatedBy(req));
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Grouped batches for one item from the latest Price Upload -- used by
    // the GRN Price Checker modal.
    router.get("/items-by-product", async (req, res) => {
      try {
        const raw =
          req.query.product_id != null ? String(req.query.product_id).trim() : "";
        const productId = parseInt(raw, 10);
        if (!raw || !Number.isFinite(productId)) {
          res.status(400).json({ code: 400, msg: "product_id is required" });
          res.end();
          return;
        }

        const data = await this.offersV3Usecase.listGroupedItemsByProductId(productId);
        res.json({
          code: 200,
          data,
          meta: { product_id: productId, count: data?.length ?? 0 },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Untagged-batch alerts
    router.get("/untagged-batches", async (req, res) => {
      try {
        const data = await this.offersV3Usecase.listUntaggedBatches(req.query.status || "pending");
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/untagged-batches/:id/dismiss", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const result = await this.offersV3Usecase.dismissUntaggedBatch(id);
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/untagged-batches/dismiss-all", async (req, res) => {
      try {
        const result = await this.offersV3Usecase.dismissAllUntaggedBatches();
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Low-stock warnings (item-level offers only)
    router.get("/low-stock-warnings", async (req, res) => {
      try {
        const data = await this.offersV3Usecase.listLowStockWarnings(req.query.status || "pending");
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/low-stock-warnings/:id/dismiss", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const result = await this.offersV3Usecase.dismissLowStockWarning(id);
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Rows/products/last-uploaded-at summary per upload type (stock/price/import)
    router.get("/upload-meta", async (req, res) => {
      try {
        const data = await this.offersV3Usecase.getUploadMeta();
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Selling-price mismatch check
    router.get("/mismatches", async (req, res) => {
      try {
        const data = await this.offersV3Usecase.computeMismatches();
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // One-time go-live import
    router.post("/import", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, importSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.importOffers(isValid.value, getCreatedBy(req));
        sendResult(res, result);
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

module.exports = (offersV3Usecase) => {
  return new OffersV3Routes(offersV3Usecase);
};
