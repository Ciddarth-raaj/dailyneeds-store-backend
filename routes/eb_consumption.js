const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class EbConsumptionRoutes {
  constructor(usecase) {
    this.usecase = usecase;
    this.init();
  }

  init() {
    // Create EB Consumption record
    router.post("/", async (req, res) => {
      try {
        const schema = Joi.object({
          consumption_id: Joi.number().integer().positive().optional(),
          date: Joi.date().required(),
          branch_id: Joi.number().integer().positive().required(),
          closing_units: Joi.number().precision(2).optional(),
          opening_units: Joi.number().precision(2).optional(),
          eb_machines: Joi.array()
            .items(
              Joi.object({
                eb_machine_id: Joi.number().integer().positive().required(),
                opening_units: Joi.number().precision(2).required(),
                closing_units: Joi.number().precision(2).required(),
              })
            )
            .optional(),
        }).or("eb_machines", "closing_units", "opening_units"); // At least one of these must be present

        const { error, value } = schema.validate(req.body);
        if (error) {
          throw error;
        }

        const data = {
          ...value,
          created_by: req.decoded.employee_id,
        };

        // If eb_machines is not provided but old format is used, keep backward compatibility
        if (
          !data.eb_machines &&
          data.opening_units !== undefined &&
          data.closing_units !== undefined
        ) {
          // Legacy format - keep as is
        }

        const result = await this.usecase.create(data);
        res.status(result.code === 200 ? 200 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Get all EB Consumption records
    router.get("/", async (req, res) => {
      try {
        const result = await this.usecase.getAll();
        res.status(result.code === 200 ? 200 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Get EB Consumption record by ID
    router.get("/:consumptionId", async (req, res) => {
      try {
        const schema = Joi.object({
          consumptionId: Joi.number().integer().positive().required(),
        });

        const { error, value } = schema.validate({
          consumptionId: parseInt(req.params.consumptionId),
        });
        if (error) {
          throw error;
        }

        const result = await this.usecase.getById(value.consumptionId);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Update EB Consumption record
    router.put("/:consumptionId", async (req, res) => {
      try {
        const paramsSchema = Joi.object({
          consumptionId: Joi.number().integer().positive().required(),
        });

        const bodySchema = Joi.object({
          date: Joi.date().optional(),
          branch_id: Joi.number().integer().positive().optional(),
          closing_units: Joi.number().precision(2).allow(null, "").optional(),
          opening_units: Joi.number().precision(2).allow(null, "").optional(),
          eb_machine_id: Joi.number().integer().positive().optional(),
          eb_machines: Joi.array()
            .items(
              Joi.object({
                eb_machine_id: Joi.number().integer().positive().required(),
                opening_units: Joi.number().precision(2).required(),
                closing_units: Joi.number().precision(2).required(),
              })
            )
            .optional(),
        }).min(1); // At least one field must be provided

        const paramsValidation = paramsSchema.validate({
          consumptionId: parseInt(req.params.consumptionId),
        });
        if (paramsValidation.error) {
          throw paramsValidation.error;
        }

        const bodyValidation = bodySchema.validate(req.body);
        if (bodyValidation.error) {
          throw bodyValidation.error;
        }

        const updateData = {
          ...bodyValidation.value,
        };

        // If eb_machines is provided, include created_by for bulk operations
        if (updateData.eb_machines) {
          updateData.created_by = req.decoded.employee_id;
        }

        const result = await this.usecase.update(
          paramsValidation.value.consumptionId,
          updateData
        );
        res
          .status(result.code === 200 ? 200 : result.code === 404 ? 404 : 400)
          .json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Update EB Consumption records by date and branch (new format)
    router.put("/by-date-branch", async (req, res) => {
      try {
        const schema = Joi.object({
          date: Joi.date().required(),
          branch_id: Joi.number().integer().positive().required(),
          eb_machines: Joi.array()
            .items(
              Joi.object({
                eb_machine_id: Joi.number().integer().positive().required(),
                opening_units: Joi.number().precision(2).required(),
                closing_units: Joi.number().precision(2).required(),
              })
            )
            .min(1)
            .required(),
        });

        const { error, value } = schema.validate(req.body);
        if (error) {
          throw error;
        }

        const data = {
          ...value,
          created_by: req.decoded.employee_id,
        };

        const result = await this.usecase.create(data);
        res.status(result.code === 200 ? 200 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Get EB Consumption records by date and branch
    router.get("/by-date-branch", async (req, res) => {
      try {
        const schema = Joi.object({
          date: Joi.date().required(),
          branch_id: Joi.number().integer().positive().required(),
        });

        const { error, value } = schema.validate(req.query);
        if (error) {
          throw error;
        }

        const result = await this.usecase.getByDateAndBranch(
          value.date,
          value.branch_id
        );
        res.status(result.code === 200 ? 200 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Delete EB Consumption record
    router.delete("/:consumptionId", async (req, res) => {
      try {
        const schema = Joi.object({
          consumptionId: Joi.number().integer().positive().required(),
        });

        const { error, value } = schema.validate({
          consumptionId: parseInt(req.params.consumptionId),
        });
        if (error) {
          throw error;
        }

        const result = await this.usecase.delete(value.consumptionId);
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

module.exports = (usecase) => {
  return new EbConsumptionRoutes(usecase);
};
