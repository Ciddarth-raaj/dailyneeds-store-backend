const logger = require("../utils/logger");

const TABLE = "gst_b2b_invoice_items";

function parseItmDetExtra(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function mapItemRow(r) {
  if (!r) return null;
  return {
    gst_b2b_invoice_item_id: r.gst_b2b_invoice_item_id,
    gst_b2b_invoice_id: r.gst_b2b_invoice_id,
    line_index: r.line_index,
    rt: r.rt,
    txval: r.txval,
    iamt: r.iamt,
    camt: r.camt,
    samt: r.samt,
    csamt: r.csamt,
    cesrt: r.cesrt,
    cesamt: r.cesamt,
    adamt: r.adamt,
    itm_det_extra: parseItmDetExtra(r.itm_det_extra),
    created_at: r.created_at,
  };
}

class GstB2bInvoiceItemRepository {
  constructor(db) {
    this.db = db;
  }

  listByInvoiceIds(invoiceIds) {
    if (!invoiceIds || invoiceIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = invoiceIds.map(() => "?").join(",");
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_b2b_invoice_item_id, gst_b2b_invoice_id, line_index, rt, txval, iamt, camt, samt, csamt, cesrt, cesamt, adamt, itm_det_extra, created_at
         FROM ${TABLE}
         WHERE gst_b2b_invoice_id IN (${placeholders})
         ORDER BY gst_b2b_invoice_id ASC, line_index ASC`,
        invoiceIds,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B_INVOICE_ITEM",
              code: "REPOSITORY.GST_B2B_INVOICE_ITEM.LIST_BY_INVOICE_IDS",
              description: err.toString(),
              category: "",
              ref: { count: invoiceIds.length },
            });
            return reject(err);
          }
          resolve((rows || []).map(mapItemRow));
        }
      );
    });
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
