const router = require("express").Router();
const Joi = require("@hapi/joi");

/** Nothing may ask for more than this in one page. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;

const ITEM_TYPES = ["ticket", "task"];
const STATUSES = ["open", "in_progress", "closed"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const SORT_FIELDS = [
  "id",
  "title",
  "status",
  "priority",
  "due_date",
  "created_at",
  "updated_at",
];

/**
 * Shared field rules. `outlet_id`, `department_id` and `assigned_to` all accept
 * null, because an item may legitimately be filed against a department with no
 * branch (or vice versa) and may sit unassigned.
 */
const itemFields = {
  title: Joi.string(),
  item_type: Joi.string().valid(ITEM_TYPES),
  description: Joi.string().allow(null, ""),
  status: Joi.string().valid(STATUSES),
  priority: Joi.string().valid(PRIORITIES),
  due_date: Joi.string().isoDate().allow(null, ""),
  outlet_id: Joi.number().allow(null),
  assigned_to: Joi.number().allow(null),
  department_id: Joi.number().allow(null),
  parent_id: Joi.number().allow(null),
};

const recurrenceSchema = Joi.object().keys({
  frequency: Joi.string().valid(["daily", "weekly", "monthly"]).required(),
  interval_value: Joi.number().integer().min(1).max(365).optional(),
  day_of_week: Joi.number().integer().min(0).max(6).allow(null).optional(),
  day_of_month: Joi.number().integer().min(1).max(31).allow(null).optional(),
  due_in_days: Joi.number().integer().min(0).max(365).optional(),
  next_run_on: Joi.string().isoDate().optional(),
  is_active: Joi.boolean().optional(),
});

/**
 * Empty strings from form posts mean "not set", not "set to empty".
 * Anything else is trimmed to YYYY-MM-DD, since the column is a DATE and a
 * full ISO timestamp would not store cleanly.
 */
const normaliseDate = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  return String(value).slice(0, 10);
};

class TicketRoutes {
  constructor(ticketUsecase, permissions) {
    this.ticketUsecase = ticketUsecase;
    this.permissions = permissions;
    this.init();
  }

  /** Turns a thrown error into the response shape the app already expects. */
  fail(res, err) {
    if (err && err.name === "ValidationError") {
      res.json({ code: 422, msg: err.toString() });
    } else {
      console.log(err);
      res.json({ code: 500, msg: (err && err.message) || "An error occurred !" });
    }
  }

  /**
   * Who may change this item: anyone with edit_tickets, the person who raised
   * it, or the person it is assigned to — the assignee only to move status and
   * tick checklist items, which is the whole "My Work" flow.
   */
  async resolveEditAccess(req, ticket) {
    const employeeId = Number(req.decoded && req.decoded.employee_id);

    if (await this.permissions.has(req, "edit_tickets")) {
      return { allowed: true, statusOnly: false };
    }

    if (ticket.created_by && Number(ticket.created_by) === employeeId) {
      return { allowed: true, statusOnly: false };
    }

    if (ticket.assigned_to && Number(ticket.assigned_to) === employeeId) {
      return { allowed: true, statusOnly: true };
    }

    return { allowed: false, statusOnly: false };
  }

  init() {
    const { require: needs } = this.permissions;

    const canView = needs("view_tickets", "view_my_tickets", "view_tasks");
    const canCreate = needs("add_tickets", "add_tasks");

    // ---------------------------------------------------------------- list

    router.get("/", canView, async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().integer().min(1).optional(),
          offset: Joi.number().integer().min(0).optional(),
          item_type: Joi.string().valid(ITEM_TYPES).optional(),
          status: Joi.string().valid(STATUSES).optional(),
          priority: Joi.string().valid(PRIORITIES).optional(),
          outlet_id: Joi.number().optional(),
          created_by: Joi.number().optional(),
          assigned_to: Joi.number().optional(),
          department_id: Joi.number().optional(),
          parent_id: Joi.number().optional(),
          involving: Joi.number().optional(),
          search: Joi.string().allow("").optional(),
          overdue: Joi.boolean().optional(),
          unassigned: Joi.boolean().optional(),
          is_open: Joi.boolean().optional(),
          due_before: Joi.string().isoDate().optional(),
          due_after: Joi.string().isoDate().optional(),
          sort_by: Joi.string().valid(SORT_FIELDS).optional(),
          sort_dir: Joi.string().valid(["asc", "desc"]).optional(),
        };

        const isValid = Joi.validate(req.query, schema, { allowUnknown: true });
        if (isValid.error !== null) throw isValid.error;

        const query = isValid.value;

        const filters = {};
        [
          "item_type",
          "status",
          "priority",
          "outlet_id",
          "created_by",
          "assigned_to",
          "department_id",
          "parent_id",
          "involving",
          "search",
          "overdue",
          "unassigned",
          "is_open",
          "due_before",
          "due_after",
        ].forEach((key) => {
          if (query[key] !== undefined && query[key] !== "") {
            filters[key] = query[key];
          }
        });

        const limit = Math.min(
          parseInt(query.limit, 10) || DEFAULT_LIMIT,
          MAX_LIMIT
        );
        const offset = parseInt(query.offset, 10) || 0;

        const [tickets, count] = await Promise.all([
          this.ticketUsecase.getAll(
            filters,
            limit,
            offset,
            query.sort_by,
            query.sort_dir
          ),
          this.ticketUsecase.getCount(filters),
        ]);

        res.json({ tickets, count, limit, offset });
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // Counts for the dashboard strip, using the same filters as the list.
    router.get("/summary", canView, async (req, res) => {
      try {
        const filters = {};
        ["item_type", "outlet_id", "department_id", "assigned_to", "involving"]
          .forEach((key) => {
            if (req.query[key] !== undefined && req.query[key] !== "") {
              filters[key] = req.query[key];
            }
          });

        const summary = await this.ticketUsecase.getSummary(filters);
        res.json(summary);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ---------------------------------------------------------- recurrences
    // Declared before /:id so the literal path is never read as an id.

    router.get(
      "/recurrences",
      needs("manage_recurring_tasks", "view_tasks"),
      async (req, res) => {
        try {
          res.json(await this.ticketUsecase.getRecurrences());
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    router.put(
      "/recurrences/:recurrenceId(\\d+)",
      needs("manage_recurring_tasks"),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            frequency: Joi.string().valid(["daily", "weekly", "monthly"]).optional(),
            interval_value: Joi.number().integer().min(1).max(365).optional(),
            day_of_week: Joi.number().integer().min(0).max(6).allow(null).optional(),
            day_of_month: Joi.number().integer().min(1).max(31).allow(null).optional(),
            due_in_days: Joi.number().integer().min(0).max(365).optional(),
            next_run_on: Joi.string().isoDate().optional(),
            is_active: Joi.boolean().optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.ticketUsecase.updateRecurrence(
              parseInt(req.params.recurrenceId, 10),
              isValid.value
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    router.delete(
      "/recurrences/:recurrenceId(\\d+)",
      needs("manage_recurring_tasks"),
      async (req, res) => {
        try {
          res.json(
            await this.ticketUsecase.deleteRecurrence(
              parseInt(req.params.recurrenceId, 10)
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    // Lets an operator run the generator by hand rather than waiting for 6am.
    router.post(
      "/recurrences/run",
      needs("manage_recurring_tasks"),
      async (req, res) => {
        try {
          res.json(await this.ticketUsecase.runRecurringTaskGeneration());
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    // -------------------------------------------------------------- create

    router.post("/", canCreate, async (req, res) => {
      try {
        const schema = {
          ...itemFields,
          title: itemFields.title.required(),
          images: Joi.array().items(Joi.string().uri()).optional(),
          checklist: Joi.array().items(Joi.string()).optional(),
          recurrence: recurrenceSchema.allow(null).optional(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const ticket = { ...isValid.value };
        ticket.due_date = normaliseDate(ticket.due_date);

        // created_by joins against new_employee.employee_id, so it must be the
        // employee id — not the user id.
        if (req.decoded && req.decoded.employee_id) {
          ticket.created_by = req.decoded.employee_id;
        }

        // Only default the branch once we know none was supplied.
        if (
          (ticket.outlet_id === undefined || ticket.outlet_id === null) &&
          !ticket.department_id &&
          req.decoded &&
          req.decoded.store_id
        ) {
          ticket.outlet_id = req.decoded.store_id;
        }

        res.json(await this.ticketUsecase.create(ticket));
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ------------------------------------------------------------ read one

    router.get("/:id(\\d+)", canView, async (req, res) => {
      try {
        const ticket = await this.ticketUsecase.getById(
          parseInt(req.params.id, 10)
        );
        if (!ticket) {
          res.status(404).json({ code: 404, msg: "Ticket not found" });
        } else {
          res.json(ticket);
        }
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.get("/:id(\\d+)/activity", canView, async (req, res) => {
      try {
        res.json(
          await this.ticketUsecase.getActivity(parseInt(req.params.id, 10))
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // -------------------------------------------------------------- update

    router.put("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);

        const schema = {
          ...itemFields,
          images_to_delete: Joi.array().items(Joi.number().integer()).optional(),
          images_to_add: Joi.array().items(Joi.string().uri()).optional(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const existing = await this.ticketUsecase.getById(id);
        if (!existing) {
          res.status(404).json({ code: 404, msg: "Ticket not found" });
          res.end();
          return;
        }

        const access = await this.resolveEditAccess(req, existing);
        if (!access.allowed) {
          res.status(403).json({
            code: 403,
            msg: "You do not have permission to edit this item",
          });
          res.end();
          return;
        }

        let changes = { ...isValid.value };
        if (changes.due_date !== undefined) {
          changes.due_date = normaliseDate(changes.due_date);
        }

        // An assignee who isn't the author may only move it along.
        if (access.statusOnly) {
          changes = changes.status === undefined ? {} : { status: changes.status };
        }

        res.json(
          await this.ticketUsecase.update(
            id,
            changes,
            req.decoded && req.decoded.employee_id
          )
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.delete(
      "/:id(\\d+)",
      needs("delete_tickets"),
      async (req, res) => {
        try {
          res.json(
            await this.ticketUsecase.delete(parseInt(req.params.id, 10))
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    // ------------------------------------------------------------ comments

    router.get("/:id(\\d+)/comments", canView, async (req, res) => {
      try {
        res.json(
          await this.ticketUsecase.getComments(parseInt(req.params.id, 10))
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.post("/:id(\\d+)/comments", canView, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, {
          comment: Joi.string().max(4000).required(),
        });
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.ticketUsecase.addComment(
            parseInt(req.params.id, 10),
            req.decoded && req.decoded.employee_id,
            isValid.value.comment
          )
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.delete("/comments/:commentId(\\d+)", async (req, res) => {
      try {
        const commentId = parseInt(req.params.commentId, 10);
        const comment = await this.ticketUsecase.getCommentById(commentId);

        if (!comment) {
          res.status(404).json({ code: 404, msg: "Comment not found" });
          res.end();
          return;
        }

        // Your own comment, or someone with edit rights clearing up.
        const isAuthor =
          Number(comment.employee_id) ===
          Number(req.decoded && req.decoded.employee_id);

        if (!isAuthor && !(await this.permissions.has(req, "edit_tickets"))) {
          res.status(403).json({
            code: 403,
            msg: "You can only delete your own comments",
          });
          res.end();
          return;
        }

        res.json(await this.ticketUsecase.deleteComment(commentId));
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // ----------------------------------------------------------- checklist

    router.get("/:id(\\d+)/checklist", canView, async (req, res) => {
      try {
        res.json(
          await this.ticketUsecase.getChecklist(parseInt(req.params.id, 10))
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.post("/:id(\\d+)/checklist", canView, async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const isValid = Joi.validate(req.body, {
          title: Joi.string().max(255).required(),
        });
        if (isValid.error !== null) throw isValid.error;

        const existing = await this.ticketUsecase.getById(id);
        if (!existing) {
          res.status(404).json({ code: 404, msg: "Ticket not found" });
          res.end();
          return;
        }

        const access = await this.resolveEditAccess(req, existing);
        if (!access.allowed || access.statusOnly) {
          res.status(403).json({
            code: 403,
            msg: "You do not have permission to change this checklist",
          });
          res.end();
          return;
        }

        res.json(
          await this.ticketUsecase.addChecklistItem(id, isValid.value.title)
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    // Ticking a step is open to anyone who can edit the item, assignee included.
    router.put("/checklist/:checklistItemId(\\d+)", async (req, res) => {
      try {
        const checklistItemId = parseInt(req.params.checklistItemId, 10);

        const isValid = Joi.validate(req.body, {
          title: Joi.string().max(255).optional(),
          is_done: Joi.boolean().optional(),
          position: Joi.number().integer().min(0).optional(),
        });
        if (isValid.error !== null) throw isValid.error;

        const item = await this.ticketUsecase.getChecklistItemById(
          checklistItemId
        );
        if (!item) {
          res.status(404).json({ code: 404, msg: "Checklist item not found" });
          res.end();
          return;
        }

        const parent = await this.ticketUsecase.getById(item.ticket_id);
        const access = await this.resolveEditAccess(req, parent);

        if (!access.allowed) {
          res.status(403).json({
            code: 403,
            msg: "You do not have permission to change this checklist",
          });
          res.end();
          return;
        }

        // An assignee may tick and untick, but not reword the steps.
        const changes = access.statusOnly
          ? { is_done: isValid.value.is_done }
          : isValid.value;

        res.json(
          await this.ticketUsecase.updateChecklistItem(
            checklistItemId,
            changes,
            req.decoded && req.decoded.employee_id
          )
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.delete(
      "/checklist/:checklistItemId(\\d+)",
      needs("edit_tickets", "add_tickets", "add_tasks"),
      async (req, res) => {
        try {
          res.json(
            await this.ticketUsecase.deleteChecklistItem(
              parseInt(req.params.checklistItemId, 10)
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    // -------------------------------------------------------------- images

    router.post("/:id(\\d+)/images", canView, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, {
          s3_url: Joi.string().uri().required(),
        });
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.ticketUsecase.createImage(
            parseInt(req.params.id, 10),
            isValid.value.s3_url
          )
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.get("/:id(\\d+)/images", canView, async (req, res) => {
      try {
        res.json(
          await this.ticketUsecase.getImagesByTicketId(
            parseInt(req.params.id, 10)
          )
        );
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    router.delete(
      "/images/:imageId(\\d+)",
      needs("edit_tickets", "add_tickets", "add_tasks"),
      async (req, res) => {
        try {
          res.json(
            await this.ticketUsecase.deleteImage(
              parseInt(req.params.imageId, 10)
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );
  }

  getRouter() {
    return router;
  }
}

module.exports = (ticketUsecase, permissions) => {
  return new TicketRoutes(ticketUsecase, permissions);
};
