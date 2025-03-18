const logger = require("../utils/logger");

class DebitNoteRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO debit_note (
          store_id, mprh_pr_no, mprh_pr_refno, mprh_pr_dt,
          mprh_dist_code, supplier_id, supplier_name, supplier_gstn,
          tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
          tot_item_qty, tot_item_value, ts, sgst, cgst, igst, cess
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          store_id = VALUES(store_id),
          mprh_pr_no = VALUES(mprh_pr_no),
          mprh_pr_dt = VALUES(mprh_pr_dt),
          mprh_dist_code = VALUES(mprh_dist_code),
          supplier_id = VALUES(supplier_id),
          supplier_name = VALUES(supplier_name),
          supplier_gstn = VALUES(supplier_gstn),
          tot_sgst_amt = VALUES(tot_sgst_amt),
          tot_cgst_amt = VALUES(tot_cgst_amt),
          tot_igst_amt = VALUES(tot_igst_amt),
          tot_gst_cess_amt = VALUES(tot_gst_cess_amt),
          tot_item_qty = VALUES(tot_item_qty),
          tot_item_value = VALUES(tot_item_value),
          ts = VALUES(ts),
          sgst = VALUES(sgst),
          cgst = VALUES(cgst),
          igst = VALUES(igst),
          cess = VALUES(cess)`,
        [
          data.STORE_ID,
          data.MPRH_PR_NO,
          data.MPRH_PR_REFNO,
          data.MPRH_PR_DT,
          data.MPRH_DIST_CODE,
          data.SUPPLIER_ID,
          data.SUPPLIER_NAME,
          data.SUPPLIER_GSTN,
          data.TOT_SGST_AMT,
          data.TOT_CGST_AMT,
          data.TOT_IGST_AMT,
          data.TOT_GST_CESS_AMT,
          data.TOT_ITEM_QTY,
          data.TOT_ITEM_VALUE,
          data.TS,
          JSON.stringify(data.SGST),
          JSON.stringify(data.CGST),
          JSON.stringify(data.IGST),
          JSON.stringify(data.CESS),
        ],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEBIT_NOTE",
              code: "REPOSITORY.DEBIT_NOTE.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            message: result.insertId
              ? "Created successfully"
              : "Updated successfully",
            data: result,
          });
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.store_id) {
        filterConditions.push("store_id = ?");
        filterValues.push(filters.store_id);
      }

      if (filters.from_date) {
        filterConditions.push("DATE(mprh_pr_dt) >= ?");
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push("DATE(mprh_pr_dt) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT * FROM debit_note ${whereClause} ORDER BY created_at DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEBIT_NOTE",
              code: "REPOSITORY.DEBIT_NOTE.GET-ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          const parsedDocs = docs.map((doc) => ({
            ...doc,
            sgst: JSON.parse(doc.sgst),
            cgst: JSON.parse(doc.cgst),
            igst: JSON.parse(doc.igst),
            cess: JSON.parse(doc.cess),
          }));

          resolve({ code: 200, data: parsedDocs });
        }
      );
    });
  }

  bulkCreate(dataList) {
    return new Promise((resolve, reject) => {
      const values = dataList
        .map((data) => [
          data.STORE_ID,
          data.MPRH_PR_NO,
          data.MPRH_PR_REFNO,
          data.MPRH_PR_DT,
          data.MPRH_DIST_CODE,
          data.SUPPLIER_ID,
          data.SUPPLIER_NAME,
          data.SUPPLIER_GSTN,
          data.TOT_SGST_AMT,
          data.TOT_CGST_AMT,
          data.TOT_IGST_AMT,
          data.TOT_GST_CESS_AMT,
          data.TOT_ITEM_QTY,
          data.TOT_ITEM_VALUE,
          data.TS,
          JSON.stringify(data.SGST),
          JSON.stringify(data.CGST),
          JSON.stringify(data.IGST),
          JSON.stringify(data.CESS),
        ])
        .flat();

      const placeholders = dataList
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");

      this.db.query(
        `INSERT INTO debit_note (
          store_id, mprh_pr_no, mprh_pr_refno, mprh_pr_dt,
          mprh_dist_code, supplier_id, supplier_name, supplier_gstn,
          tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
          tot_item_qty, tot_item_value, ts, sgst, cgst, igst, cess
        ) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          store_id = VALUES(store_id),
          mprh_pr_no = VALUES(mprh_pr_no),
          mprh_pr_dt = VALUES(mprh_pr_dt),
          mprh_dist_code = VALUES(mprh_dist_code),
          supplier_id = VALUES(supplier_id),
          supplier_name = VALUES(supplier_name),
          supplier_gstn = VALUES(supplier_gstn),
          tot_sgst_amt = VALUES(tot_sgst_amt),
          tot_cgst_amt = VALUES(tot_cgst_amt),
          tot_igst_amt = VALUES(tot_igst_amt),
          tot_gst_cess_amt = VALUES(tot_gst_cess_amt),
          tot_item_qty = VALUES(tot_item_qty),
          tot_item_value = VALUES(tot_item_value),
          ts = VALUES(ts),
          sgst = VALUES(sgst),
          cgst = VALUES(cgst),
          igst = VALUES(igst),
          cess = VALUES(cess)`,
        values,
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEBIT_NOTE",
              code: "REPOSITORY.DEBIT_NOTE.BULK-CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            message: `Successfully processed ${dataList.length} records (${result.affectedRows} inserted/updated)`,
          });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new DebitNoteRepository(db);
};
