const router = require("express").Router();
const Joi = require("@hapi/joi");

class CleaningPackingRoutes {
  constructor(cleaningPackingUsecase) {
    this.cleaningPackingUsecase = cleaningPackingUsecase;
    this.init();
  }

  init() {
    // Create purchase item
    router.post("/", async (req, res) => {
      try {
        const schema = {
          purchase_item: Joi.number().required(),
          purchase_item_name: Joi.string().required(),
          article_id: Joi.number().allow(null),
          article_name: Joi.string().allow(null, ""),
          priority_score: Joi.number().allow(null),
          repackage_conversion: Joi.number().allow(null),
          planner: Joi.string().allow(null, ""),
          repack_quantity: Joi.number().allow(null),
          forecast_quantity: Joi.number().allow(null),
          order_date: Joi.date().allow(null),
          child_stock_in_hand: Joi.number().allow(null),
          parent_stock: Joi.number().allow(null),
          store_uom: Joi.number().allow(null),
          num_stores_oos: Joi.number().allow(null),
          chain_bill_count_level: Joi.string().allow(null, ""),
        };

        const purchaseItem = req.body;
        const isValid = Joi.validate(purchaseItem, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        const result = await this.cleaningPackingUsecase.create(purchaseItem);
        res.json({
          code: 200,
          msg: "Purchase item created successfully",
          data: result,
        });
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred!" });
        }
      }
    });

    // Get all purchase items with optional filters
    router.get("/", async (req, res) => {
      try {
        const filters = {};

        // Date filter
        if (req.query.date) {
          filters.date = req.query.date;
        }

        // Cleaning filter
        if (req.query.cleaning !== undefined) {
          filters.cleaning =
            req.query.cleaning === "true"
              ? true
              : req.query.cleaning === "false"
              ? false
              : null;
        }

        // Packing type filter
        if (req.query.packing_type !== undefined) {
          filters.packing_type = req.query.packing_type
            ? parseInt(req.query.packing_type)
            : null;
        }

        // Packing material filter
        if (req.query.packing_material !== undefined) {
          filters.packing_material = req.query.packing_material
            ? parseInt(req.query.packing_material)
            : null;
        }

        // Packing material size filter
        if (req.query.packing_material_size !== undefined) {
          filters.packing_material_size = req.query.packing_material_size
            ? parseInt(req.query.packing_material_size)
            : null;
        }

        // Sticker filter
        if (req.query.sticker !== undefined) {
          filters.sticker =
            req.query.sticker === "true"
              ? true
              : req.query.sticker === "false"
              ? false
              : null;
        }

        const purchaseItems = await this.cleaningPackingUsecase.getAll(filters);
        res.json({ code: 200, data: purchaseItems });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred!" });
      }
    });

    // Delete all purchase items
    router.delete("/", async (req, res) => {
      try {
        const result = await this.cleaningPackingUsecase.deleteAll();
        res.json({
          code: 200,
          msg: "All purchase items deleted successfully",
          data: result,
        });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred!" });
      }
    });

    // Sync all data
    router.post("/sync", async (req, res) => {
      try {
        const result = await this.cleaningPackingUsecase.sync();
        res.json({ code: 200, msg: "Data successfully synced!" });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred!" });
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (cleaningPackingUsecase) => {
  return new CleaningPackingRoutes(cleaningPackingUsecase);
};
