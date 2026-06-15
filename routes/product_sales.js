const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

/** @param {string} s DD-MM-YYYY */
function tranDateDdMmYyyyToMysql(s) {
  const m = String(s)
    .trim()
    .match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yyyy = parseInt(m[3], 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(yyyy, mm - 1, dd);
  if (
    dt.getFullYear() !== yyyy ||
    dt.getMonth() !== mm - 1 ||
    dt.getDate() !== dd
  ) {
    return null;
  }
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return `${yyyy}-${pad(mm)}-${pad(dd)}`;
}

const saleRowSchema = Joi.object({
  RETAIL_OUTLET_ID: Joi.alternatives()
    .try(Joi.string(), Joi.number())
    .required(),
  ITEM_CODE: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  TRAN_DATE: Joi.string()
    .regex(/^\d{2}-\d{2}-\d{4}$/)
    .required(),
  TRAN_QTY: Joi.number().required(),
  TRAN_AMT: Joi.number().required(),
  DISC_AMT: Joi.number().required(),
  GROSS_AMT: Joi.number().required(),
  NET_AMT: Joi.number().required(),
  PROFIT: Joi.number().required(),
});

const bulkSchema = Joi.array().items(saleRowSchema).min(1).required();

class ProductSalesRoutes {
  constructor(productSalesUsecase) {
    this.productSalesUsecase = productSalesUsecase;
    this.init();
  }

  init() {
    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const rows = [];
        for (const r of isValid.value) {
          const retail_outlet_id = parseInt(String(r.RETAIL_OUTLET_ID).trim(), 10);
          if (!Number.isFinite(retail_outlet_id) || retail_outlet_id <= 0) {
            res.status(400).json({
              code: 400,
              msg: `Invalid RETAIL_OUTLET_ID: ${r.RETAIL_OUTLET_ID}`,
            });
            res.end();
            return;
          }

          const tran_date = tranDateDdMmYyyyToMysql(r.TRAN_DATE);
          if (!tran_date) {
            res.status(400).json({
              code: 400,
              msg: `Invalid TRAN_DATE: ${r.TRAN_DATE} (use DD-MM-YYYY, e.g. 01-01-2023)`,
            });
            res.end();
            return;
          }
          rows.push({
            retail_outlet_id,
            item_code: r.ITEM_CODE,
            tran_date,
            tran_qty: r.TRAN_QTY,
            tran_amt: r.TRAN_AMT,
            disc_amt: r.DISC_AMT,
            gross_amt: r.GROSS_AMT,
            net_amt: r.NET_AMT,
            profit: r.PROFIT,
          });
        }
        const result = await this.productSalesUsecase.bulkCreate(rows);
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

module.exports = (productSalesUsecase) => {
  return new ProductSalesRoutes(productSalesUsecase);
};
