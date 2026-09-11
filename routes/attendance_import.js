const express = require("express");
const Joi = require("@hapi/joi");
const formidable = require("formidable");
const fs = require("fs");
const os = require("os");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const { MAX_UPLOAD_BYTES } = require("../usecase/attendance_import");

/**
 * DigiSME Excel attendance import. Mounted at /attendance/imports.
 *
 *   POST /digisme/preview   multipart, one .xlsx -> staged batch + summary   manage_attendance_import
 *   GET  /                  import history                                   manage_attendance_import
 *   GET  /details           one batch: counts, unmatched codes               manage_attendance_import
 *   GET  /items             paginated items of one batch (by classification) manage_attendance_import
 *   POST /commit            commit a PREVIEWED batch                         manage_attendance_import
 *
 * ADMIN ONLY at this stage: the key is granted to no designation. The upload
 * is parsed with formidable (the project's existing upload library) into a
 * temporary file that is deleted as soon as it has been read; no server
 * path is ever returned. Only one file, only .xlsx, only up to
 * MAX_UPLOAD_BYTES.
 */
class AttendanceImportRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const r = this.router;
    const P_ = this.permissions;

    r.post("/digisme/preview", P_.require(P.MANAGE_ATTENDANCE_IMPORT), async (req, res) => {
      let tmp = null;
      try {
        const file = await this.readUpload(req);
        tmp = file.path;
        const out = await this.usecase.preview(file, await this.permissions.actorFor(req));
        res.json(out);
      } catch (err) {
        this.fail(res, err);
      } finally {
        if (tmp) fs.unlink(tmp, () => {});
      }
    });

    r.get("/", P_.require(P.MANAGE_ATTENDANCE_IMPORT), async (req, res) => {
      try {
        this.validate(req.query, { limit: Joi.number().integer().min(1).max(500).optional() });
        res.json({ code: 200, data: await this.usecase.list(req.query) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/details", P_.require(P.MANAGE_ATTENDANCE_IMPORT), async (req, res) => {
      try {
        this.validate(req.query, { import_batch_id: Joi.number().integer().required() });
        res.json({ code: 200, data: await this.usecase.details(req.query.import_batch_id) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/items", P_.require(P.MANAGE_ATTENDANCE_IMPORT), async (req, res) => {
      try {
        this.validate(req.query, {
          import_batch_id: Joi.number().integer().required(),
          classification: Joi.string().optional(),
          outcome: Joi.string().optional(),
          limit: Joi.number().integer().min(1).max(1000).optional(),
          offset: Joi.number().integer().min(0).optional(),
        });
        const { import_batch_id, ...filters } = req.query;
        res.json({ code: 200, data: await this.usecase.items(import_batch_id, filters) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/commit", P_.require(P.MANAGE_ATTENDANCE_IMPORT), async (req, res) => {
      try {
        this.validate(req.body, { import_batch_id: Joi.number().integer().required() });
        res.json(await this.usecase.commit(req.body.import_batch_id, await this.permissions.actorFor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });
  }

  /** One multipart file -> {path, originalname, size}; rejects anything else. */
  readUpload(req) {
    return new Promise((resolve, reject) => {
      const form = new formidable.IncomingForm();
      form.multiples = false;
      form.maxFileSize = MAX_UPLOAD_BYTES;
      form.uploadDir = os.tmpdir();
      form.keepExtensions = false;
      form.parse(req, (err, fields, files) => {
        if (err) {
          const e = new Error(/maxFileSize/i.test(String(err.message)) ? `the file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` : "the upload could not be read");
          e.name = "ValidationError";
          reject(e);
          return;
        }
        const list = Object.values(files || {}).flat().filter(Boolean);
        if (list.length !== 1) {
          for (const f of list) if (f && f.path) fs.unlink(f.path, () => {});
          const e = new Error("exactly one .xlsx file is required");
          e.name = "ValidationError";
          reject(e);
          return;
        }
        const f = list[0];
        resolve({ path: f.path, originalname: f.name || "", size: f.size || 0 });
      });
    });
  }

  validate(payload, schema) {
    const isValid = Joi.validate(payload === undefined ? {} : payload, schema);
    if (isValid.error !== null) throw isValid.error;
  }

  fail(res, err) {
    if (err && err.httpCode) {
      res.status(err.httpCode).json({ code: err.httpCode, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new AttendanceImportRoutes(usecase, permissions);
module.exports.AttendanceImportRoutes = AttendanceImportRoutes;
