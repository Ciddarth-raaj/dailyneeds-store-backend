const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class StoCheckRoutes {
  constructor(stoCheckUsecase) {
    this.stoCheckUsecase = stoCheckUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.stoCheckUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/by-ref/:dn_ref_no", async (req, res) => {
      try {
        const dn_ref_no = parseInt(req.params.dn_ref_no, 10);
        if (isNaN(dn_ref_no)) {
          res.status(400).json({ code: 400, msg: "Invalid dn_ref_no" });
          res.end();
          return;
        }
        const list = await this.stoCheckUsecase.getByDnRefNo(dn_ref_no);
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:dn_ref_no/:product_id", async (req, res) => {
      try {
        const dn_ref_no = parseInt(req.params.dn_ref_no, 10);
        const product_id = parseInt(req.params.product_id, 10);
        if (isNaN(dn_ref_no) || isNaN(product_id)) {
          res.status(400).json({ code: 400, msg: "Invalid dn_ref_no or product_id" });
          res.end();
          return;
        }
        const row = await this.stoCheckUsecase.getOne(dn_ref_no, product_id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Record not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const replaceSchema = Joi.object({
      dn_ref_no: Joi.number().integer().required(),
      items: Joi.array()
        .items(
          Joi.object({
            product_id: Joi.number().integer().required(),
            file_qty: Joi.number().integer().min(0).allow(null).optional(),
          })
        )
        .required(),
    });

    router.put("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, replaceSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.stoCheckUsecase.replaceByDnRefNo(
          req.body.dn_ref_no,
          req.body.items
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const bulkReplaceSchema = Joi.array().items(
      Joi.object({
        dn_ref_no: Joi.number().integer().required(),
        items: Joi.array()
          .items(
            Joi.object({
              product_id: Joi.number().integer().required(),
              file_qty: Joi.number().integer().min(0).allow(null).optional(),
            })
          )
          .required(),
      })
    );

    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkReplaceSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.stoCheckUsecase.bulkReplace(req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:dn_ref_no", async (req, res) => {
      try {
        const dn_ref_no = parseInt(req.params.dn_ref_no, 10);
        if (isNaN(dn_ref_no)) {
          res.status(400).json({ code: 400, msg: "Invalid dn_ref_no" });
          res.end();
          return;
        }
        const result = await this.stoCheckUsecase.deleteByDnRefNo(dn_ref_no);
        res.json({ code: 200, ...result });
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

module.exports = (stoCheckUsecase) => {
  return new StoCheckRoutes(stoCheckUsecase);
};
