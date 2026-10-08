// routes/transporter_master.js
const express = require("express");
const Joi = require("@hapi/joi");
const { requireEmployee } = require("../utils/actor");
const sendError = require("../utils/route_errors");
const { PERMISSION } = require("../utils/transporter");
const { PERMISSION: LRF } = require("../utils/lr_followup");

/**
 * Transporter Master. Reads on view_transporter_master, adding on
 * create_transporter_master, editing (including activate / deactivate) on
 * edit_transporter_master. There is no DELETE route: an unused transporter
 * is made inactive, which keeps it on every old record.
 *
 * The dropdown list (`/options`, active only) is also open to the people who
 * pick a transporter - whoever creates an LR Follow-up or updates one - so they do not need the whole master to fill in a form.
 */

// Shape only; the field rules (contact number, name length) are in
// utils/transporter.js so create and edit are held to the same ones.
const fields = {
  transporter_name: Joi.string().max(200).allow(""),
  contact_no: Joi.string().max(40).allow(""),
  alternate_contact_no: Joi.string().max(40).allow(null, ""),
  contact_person: Joi.string().max(200).allow(null, ""),
  remarks: Joi.string().max(1000).allow(null, ""),
  is_active: Joi.boolean(),
};

class TransporterMasterRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  validate(payload, schema) {
    const result = Joi.validate(payload, schema);
    if (result.error !== null) throw result.error;
    return result.value;
  }

  init() {
    const { require: needs } = this.permissions;
    const router = this.router;

    router.get(
      "/options",
      needs(PERMISSION.VIEW, LRF.CREATE_MANUAL, LRF.UPDATE),
      async (req, res) => {
        try {
          res.json({ code: 200, data: await this.usecase.options() });
        } catch (err) {
          sendError(res, err);
        }
      }
    );

    router.get("/", needs(PERMISSION.VIEW), async (req, res) => {
      try {
        const query = this.validate(req.query, {
          is_active: Joi.boolean().optional(),
          search: Joi.string().max(100).allow("").optional(),
        });
        res.json({ code: 200, data: await this.usecase.list(query) });
      } catch (err) {
        sendError(res, err);
      }
    });

    router.get("/:id(\\d+)", needs(PERMISSION.VIEW), async (req, res) => {
      try {
        res.json({ code: 200, data: await this.usecase.getById(parseInt(req.params.id, 10)) });
      } catch (err) {
        sendError(res, err);
      }
    });

    router.post("/", needs(PERMISSION.CREATE), async (req, res) => {
      try {
        const body = this.validate(req.body, fields);
        const data = await this.usecase.create(
          body,
          requireEmployee(req, "Adding a transporter")
        );
        res.status(201).json({ code: 200, data });
      } catch (err) {
        sendError(res, err);
      }
    });

    router.patch("/:id(\\d+)", needs(PERMISSION.EDIT), async (req, res) => {
      try {
        const body = this.validate(req.body, fields);
        const data = await this.usecase.update(
          parseInt(req.params.id, 10),
          body,
          requireEmployee(req, "Editing a transporter")
        );
        res.json({ code: 200, data });
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new TransporterMasterRoutes(usecase, permissions);
