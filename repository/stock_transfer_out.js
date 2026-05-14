const logger = require("../utils/logger");

const HDR_TABLE = "medishopdb_Vw_StockTransferOut_hdr";
const DTL_TABLE = "medishopdb_Vw_StockTransferOut_dtl";

/** Calendar column on the hdr view for `from_date` / `to_date` filters (change if your view differs). */
const HDR_DATE_COLUMN = "Dn_Date";

function groupDetailsByDnNo(dtlRows) {
  const byDnNo = {};
  (dtlRows || []).forEach((row) => {
    const key = String(row.Dn_no);
    if (!byDnNo[key]) byDnNo[key] = [];
    byDnNo[key].push(row);
  });
  return byDnNo;
}

function buildList(headers, detailsByDnNo) {
  return (headers || []).map((h) => {
    const key = String(h.Dn_no);
    return {
      ...h,
      items: detailsByDnNo[key] || [],
    };
  });
}

class StockTransferOutRepository {
  constructor(dbGofrugal) {
    this.db = dbGofrugal;
  }

  /**
   * @param {{ from_date?: string, to_date?: string }} [filters] — `from_date` / `to_date` as `YYYY-MM-DD` (inclusive on `HDR_DATE_COLUMN`).
   */
  get(filters = {}) {
    const fromDate =
      filters.from_date != null && String(filters.from_date).trim() !== ""
        ? String(filters.from_date).trim()
        : null;
    const toDate =
      filters.to_date != null && String(filters.to_date).trim() !== ""
        ? String(filters.to_date).trim()
        : null;

    return new Promise((resolve, reject) => {
      const conditions = [];
      const params = [];
      if (fromDate) {
        conditions.push(`DATE(\`${HDR_DATE_COLUMN}\`) >= DATE(?)`);
        params.push(fromDate);
      }
      if (toDate) {
        conditions.push(`DATE(\`${HDR_DATE_COLUMN}\`) <= DATE(?)`);
        params.push(toDate);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const hdrSql = `SELECT * FROM \`${HDR_TABLE}\` ${where} ORDER BY Dn_no DESC`;

      this.db.query(hdrSql, params, (err, headers) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.STOCK_TRANSFER_OUT",
            code: "REPOSITORY.STOCK_TRANSFER_OUT.GET",
            description: err.toString(),
            category: "",
            ref: { from_date: fromDate, to_date: toDate },
          });
          return reject(err);
        }
        const hdrList = headers || [];
        if (hdrList.length === 0) {
          return resolve([]);
        }

        const hasDateFilter = Boolean(fromDate || toDate);
        if (!hasDateFilter) {
          this.db.query(
            `SELECT * FROM \`${DTL_TABLE}\` ORDER BY Dn_no, Dn_sl_no`,
            [],
            (err2, dtlRows) => {
              if (err2) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.STOCK_TRANSFER_OUT",
                  code: "REPOSITORY.STOCK_TRANSFER_OUT.GET_DTL",
                  description: err2.toString(),
                  category: "",
                  ref: {},
                });
                return reject(err2);
              }
              const detailsByDnNo = groupDetailsByDnNo(dtlRows);
              resolve(buildList(hdrList, detailsByDnNo));
            }
          );
          return;
        }

        const dnNos = hdrList.map((h) => h.Dn_no);
        const placeholders = dnNos.map(() => "?").join(",");
        this.db.query(
          `SELECT * FROM \`${DTL_TABLE}\` WHERE Dn_no IN (${placeholders}) ORDER BY Dn_no, Dn_sl_no`,
          dnNos,
          (err2, dtlRows) => {
            if (err2) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.STOCK_TRANSFER_OUT",
                code: "REPOSITORY.STOCK_TRANSFER_OUT.GET_DTL",
                description: err2.toString(),
                category: "",
                ref: {},
              });
              return reject(err2);
            }
            const detailsByDnNo = groupDetailsByDnNo(dtlRows);
            resolve(buildList(hdrList, detailsByDnNo));
          }
        );
      });
    });
  }

  getByDnNo(Dn_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM \`${HDR_TABLE}\` WHERE Dn_no = ?`,
        [Dn_no],
        (err, headerRows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_TRANSFER_OUT",
              code: "REPOSITORY.STOCK_TRANSFER_OUT.GET_BY_DN_NO",
              description: err.toString(),
              category: "",
              ref: { Dn_no },
            });
            return reject(err);
          }
          const header = headerRows && headerRows[0];
          if (!header) return resolve(null);
          this.db.query(
            `SELECT * FROM \`${DTL_TABLE}\` WHERE Dn_no = ? ORDER BY Dn_sl_no`,
            [Dn_no],
            (err2, dtlRows) => {
              if (err2) return reject(err2);
              resolve({
                ...header,
                items: dtlRows || [],
              });
            }
          );
        }
      );
    });
  }

  getByDnRefNo(Dn_Ref_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM \`${HDR_TABLE}\` WHERE Dn_Ref_no = ? ORDER BY Dn_no DESC`,
        [Dn_Ref_no],
        (err, headers) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_TRANSFER_OUT",
              code: "REPOSITORY.STOCK_TRANSFER_OUT.GET_BY_DN_REF_NO",
              description: err.toString(),
              category: "",
              ref: { Dn_Ref_no },
            });
            return reject(err);
          }
          if (!headers || headers.length === 0) return resolve([]);
          const dnNos = headers.map((h) => h.Dn_no);
          const placeholders = dnNos.map(() => "?").join(",");
          this.db.query(
            `SELECT * FROM \`${DTL_TABLE}\` WHERE Dn_no IN (${placeholders}) ORDER BY Dn_no, Dn_sl_no`,
            dnNos,
            (err2, dtlRows) => {
              if (err2) return reject(err2);
              const detailsByDnNo = groupDetailsByDnNo(dtlRows);
              resolve(buildList(headers, detailsByDnNo));
            }
          );
        }
      );
    });
  }
}

module.exports = (dbGofrugal) => {
  return new StockTransferOutRepository(dbGofrugal);
};
