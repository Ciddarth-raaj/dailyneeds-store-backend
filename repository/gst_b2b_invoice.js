const logger = require("../utils/logger");

const TABLE = "gst_b2b_invoices";

class GstB2bInvoiceRepository {
  constructor(db) {
    this.db = db;
  }

  insert(row) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (
          gst_b2b_id, inv_index, inum, idt, oinum, oidt, val, pos, rchrg, inv_typ, etin, fldtr1, diff_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.gst_b2b_id,
          row.inv_index,
          row.inum ?? null,
          row.idt ?? null,
          row.oinum ?? null,
          row.oidt ?? null,
          row.val ?? null,
          row.pos ?? null,
          row.rchrg ?? null,
          row.inv_typ ?? null,
          row.etin ?? null,
          row.fldtr1 ?? null,
          row.diff_percent ?? null,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B_INVOICE",
              code: "REPOSITORY.GST_B2B_INVOICE.INSERT",
              description: err.toString(),
              category: "",
              ref: { gst_b2b_id: row.gst_b2b_id },
            });
            return reject(err);
          }
          resolve(res.insertId);
        }
      );
    });
  }
}

module.exports = (db) => new GstB2bInvoiceRepository(db);
