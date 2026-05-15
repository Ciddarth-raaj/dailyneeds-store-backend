const logger = require("../utils/logger");

const TABLE = "gst_b2b_invoices";

function mapInvoiceRow(r) {
  if (!r) return null;
  return {
    gst_b2b_invoice_id: r.gst_b2b_invoice_id,
    gst_b2b_id: r.gst_b2b_id,
    inv_index: r.inv_index,
    inum: r.inum,
    idt: r.idt,
    oinum: r.oinum,
    oidt: r.oidt,
    val: r.val,
    pos: r.pos,
    rchrg: r.rchrg,
    inv_typ: r.inv_typ,
    etin: r.etin,
    fldtr1: r.fldtr1,
    diff_percent: r.diff_percent,
    created_at: r.created_at,
  };
}

class GstB2bInvoiceRepository {
  constructor(db) {
    this.db = db;
  }

  listByGstB2bIds(gstB2bIds) {
    if (!gstB2bIds || gstB2bIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = gstB2bIds.map(() => "?").join(",");
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_b2b_invoice_id, gst_b2b_id, inv_index, inum, idt, oinum, oidt, val, pos, rchrg, inv_typ, etin, fldtr1, diff_percent, created_at
         FROM ${TABLE}
         WHERE gst_b2b_id IN (${placeholders})
         ORDER BY gst_b2b_id ASC, inv_index ASC`,
        gstB2bIds,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B_INVOICE",
              code: "REPOSITORY.GST_B2B_INVOICE.LIST_BY_B2B_IDS",
              description: err.toString(),
              category: "",
              ref: { count: gstB2bIds.length },
            });
            return reject(err);
          }
          resolve((rows || []).map(mapInvoiceRow));
        }
      );
    });
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
