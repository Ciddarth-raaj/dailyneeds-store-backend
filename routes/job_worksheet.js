const router = require("express").Router();
const Joi = require("@hapi/joi");

class JobWorksheetRoutes {
  constructor(jobWorksheetUsecase) {
    this.jobWorksheetUsecase = jobWorksheetUsecase;
    this.init();
  }

  init() {
    const itemSchema = Joi.object({
      product_id: Joi.number().integer().min(1).required(),
      qty: Joi.number().integer().min(0).required(),
      mrp: Joi.number().precision(2).min(0).required(),
    });

    const createSchema = Joi.object({
      grn_no: Joi.string().max(255).required(),
      date: Joi.date().required(),
      supplier_id: Joi.number().integer().min(1).required(),
      items: Joi.array().items(itemSchema).optional(),
    });

    const updateSchema = Joi.object({
      grn_no: Joi.string().max(255).optional(),
      date: Joi.date().optional(),
      supplier_id: Joi.number().integer().min(1).optional(),
      items: Joi.array().items(itemSchema).optional(),
    });

    // Create job worksheet (with optional items)
    router.post("/", async (req, res) => {
      try {
        const { error, value } = createSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result =
          await this.jobWorksheetUsecase.createJobWorksheetWithItems(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all job worksheets
    router.get("/", async (req, res) => {
      try {
        const filters = {
          grn_no: req.query.grn_no,
          supplier_id: req.query.supplier_id
            ? parseInt(req.query.supplier_id)
            : undefined,
          date_from: req.query.date_from,
          date_to: req.query.date_to,
          limit: req.query.limit ? parseInt(req.query.limit) : undefined,
          offset: req.query.offset ? parseInt(req.query.offset) : undefined,
        };
        const result =
          await this.jobWorksheetUsecase.getAllJobWorksheets(filters);
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get job worksheet by ID
    router.get("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid job worksheet ID" });
        }
        const result = await this.jobWorksheetUsecase.getJobWorksheetById(id);
        if (!result) {
          return res.json({ code: 404, msg: "Job worksheet not found" });
        }
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get job worksheet with items
    router.get("/:id/with-items", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid job worksheet ID" });
        }
        const result =
          await this.jobWorksheetUsecase.getJobWorksheetWithItems(id);
        if (!result) {
          return res.json({ code: 404, msg: "Job worksheet not found" });
        }
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update job worksheet (with optional items)
    router.put("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid job worksheet ID" });
        }
        const { error, value } = updateSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result =
          await this.jobWorksheetUsecase.updateJobWorksheetWithItems(id, value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Delete job worksheet
    router.delete("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid job worksheet ID" });
        }
        const result = await this.jobWorksheetUsecase.deleteJobWorksheet(id);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get items for a job worksheet
    router.get("/:id/items", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid job worksheet ID" });
        }
        const result = await this.jobWorksheetUsecase.getJobWorksheetItems(id);
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Create a single item
    router.post("/:id/items", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid job worksheet ID" });
        }
        const { error, value } = itemSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result = await this.jobWorksheetUsecase.createJobWorksheetItem({
          ...value,
          job_worksheet_id: id,
        });
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update a single item
    router.put("/:id/items/:itemId", async (req, res) => {
      try {
        const itemId = parseInt(req.params.itemId);
        if (isNaN(itemId)) {
          return res.json({ code: 400, msg: "Invalid item ID" });
        }
        const { error, value } = itemSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result =
          await this.jobWorksheetUsecase.updateJobWorksheetItem(itemId, value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Delete a single item
    router.delete("/:id/items/:itemId", async (req, res) => {
      try {
        const itemId = parseInt(req.params.itemId);
        if (isNaN(itemId)) {
          return res.json({ code: 400, msg: "Invalid item ID" });
        }
        const result =
          await this.jobWorksheetUsecase.deleteJobWorksheetItem(itemId);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (jobWorksheetUsecase) => {
  return new JobWorksheetRoutes(jobWorksheetUsecase);
};
