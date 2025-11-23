const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class TicketRoutes {
  constructor(ticketUsecase) {
    this.ticketUsecase = ticketUsecase;
    this.init();
  }

  init() {
    // Create ticket
    router.post("/", async (req, res) => {
      try {
        const schema = {
          title: Joi.string().required(),
          description: Joi.string().allow(null, "").optional(),
          status: Joi.string()
            .valid("open", "in_progress", "closed")
            .optional(),
          priority: Joi.string()
            .valid("low", "medium", "high", "urgent")
            .optional(),
          outlet_id: Joi.number().optional(),
          assigned_to: Joi.number().allow(null).optional(),
          department_id: Joi.number().allow(null).optional(),
          images: Joi.array().items(Joi.string().uri()).optional(),
        };

        const ticket = req.body;
        const isValid = Joi.validate(ticket, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        // Set created_by from auth token if available
        if (req.decoded && req.decoded.id) {
          ticket.created_by = req.decoded.id;
        }

        // Set outlet_id from auth token if not provided
        if (!ticket.outlet_id && req.decoded && req.decoded.store_id) {
          ticket.outlet_id = req.decoded.store_id;
        }

        const response = await this.ticketUsecase.create(ticket);
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Get all tickets with filters
    router.get("/", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().integer().min(1).default(20),
          offset: Joi.number().integer().min(0).default(0),
          status: Joi.string()
            .valid("open", "in_progress", "closed")
            .optional(),
          priority: Joi.string()
            .valid("low", "medium", "high", "urgent")
            .optional(),
          outlet_id: Joi.number().optional(),
          created_by: Joi.number().optional(),
          assigned_to: Joi.number().optional(),
          department_id: Joi.number().optional(),
          search: Joi.string().optional(),
        };

        const query = req.query;
        const isValid = Joi.validate(query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const filters = {
          status: query.status,
          priority: query.priority,
          outlet_id: query.outlet_id,
          created_by: query.created_by,
          assigned_to: query.assigned_to,
          department_id: query.department_id,
          search: query.search,
        };

        // Remove undefined filters
        Object.keys(filters).forEach(
          (key) => filters[key] === undefined && delete filters[key]
        );

        const limit = parseInt(query.limit) || 20;
        const offset = parseInt(query.offset) || 0;

        const tickets = await this.ticketUsecase.getAll(filters, limit, offset);
        const count = await this.ticketUsecase.getCount(filters);

        res.json({
          tickets,
          count,
          limit,
          offset,
        });
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    // Get ticket by ID
    router.get("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid ticket id");
        }

        const ticket = await this.ticketUsecase.getById(id);
        if (!ticket) {
          res.status(404).json({ code: 404, msg: "Ticket not found" });
        } else {
          res.json(ticket);
        }
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    // Update ticket
    router.put("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid ticket id");
        }

        const schema = {
          title: Joi.string().optional(),
          description: Joi.string().allow(null, "").optional(),
          status: Joi.string()
            .valid("open", "in_progress", "closed")
            .optional(),
          priority: Joi.string()
            .valid("low", "medium", "high", "urgent")
            .optional(),
          outlet_id: Joi.number().optional(),
          assigned_to: Joi.number().allow(null).optional(),
          department_id: Joi.number().allow(null).optional(),
          images_to_delete: Joi.array()
            .items(Joi.number().integer())
            .optional(),
          images_to_add: Joi.array().items(Joi.string().uri()).optional(),
        };

        const ticket = req.body;
        const isValid = Joi.validate(ticket, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.ticketUsecase.update(id, ticket);
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Delete ticket
    router.delete("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid ticket id");
        }

        const result = await this.ticketUsecase.delete(id);
        res.json(result);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    // Create ticket image
    router.post("/:id(\\d+)/images", async (req, res) => {
      try {
        const ticketId = parseInt(req.params.id);
        if (isNaN(ticketId)) {
          throw new Error("Invalid ticket id");
        }

        const schema = {
          s3_url: Joi.string().uri().required(),
        };

        const body = req.body;
        const isValid = Joi.validate(body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.ticketUsecase.createImage(
          ticketId,
          body.s3_url
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
      res.end();
    });

    // Get ticket images
    router.get("/:id(\\d+)/images", async (req, res) => {
      try {
        const ticketId = parseInt(req.params.id);
        if (isNaN(ticketId)) {
          throw new Error("Invalid ticket id");
        }

        const images = await this.ticketUsecase.getImagesByTicketId(ticketId);
        res.json(images);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    // Delete ticket image
    router.delete("/images/:imageId(\\d+)", async (req, res) => {
      try {
        const imageId = parseInt(req.params.imageId);
        if (isNaN(imageId)) {
          throw new Error("Invalid image id");
        }

        const result = await this.ticketUsecase.deleteImage(imageId);
        res.json(result);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (ticketUsecase) => {
  return new TicketRoutes(ticketUsecase);
};
