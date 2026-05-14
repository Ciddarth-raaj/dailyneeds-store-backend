const logger = require("../utils/logger");

const TABLE = "gst_b2b_invoice_items";

class GstB2bInvoiceItemRepository {
  constructor(db) {
    this.db = db;
  }

  insert(row) {
    const extra =
      row.itm_det_extra == null
        ? null
        : typeof row.itm_det_extra === "string"
          ? row.itm_det_extra
          : JSON.stringify(row.itm_det_extra);
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (
          gst_b2b_invoice_id, line_index, rt, txval, iamt, camt, samt, csamt, cesrt, cesamt, adamt, itm_det_extra
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.gst_b2b_invoice_id,
          row.line_index,
          row.rt ?? null,
          row.txval ?? null,
          row.iamt ?? null,
          row.camt ?? null,
          row.samt ?? null,
          row.csamt ?? null,
          row.cesrt ?? null,
          row.cesamt ?? null,
          row.adamt ?? null,
          extra,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B_INVOICE_ITEM",
              code: "REPOSITORY.GST_B2B_INVOICE_ITEM.INSERT",
              description: err.toString(),
              category: "",
              ref: { gst_b2b_invoice_id: row.gst_b2b_invoice_id },
            });
            return reject(err);
          }
          resolve(res.insertId);
        }
      );
    });
  }
}

module.exports = (db) => new GstB2bInvoiceItemRepository(db);
