const logger = require("../utils/logger");

const HDR_TABLE = "medishopdb_Vw_StockTransferOut_hdr";
const DTL_TABLE = "medishopdb_Vw_StockTransferOut_dtl";

/** Calendar column on the hdr view for `from_date` / `to_date` filters (change if your view differs). */
const HDR_DATE_COLUMN = "Dn_Date";

/** Upper bound on the values bound into one `IN (...)` list. */
const IN_CHUNK_SIZE = 1000;

function chunk(values, size = IN_CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** `YYYY-MM-DD` + 1 calendar day, as `YYYY-MM-DD` (pure calendar arithmetic, no time zone). */
function nextDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function trimmedOrNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * Inclusive `from_date` / `to_date` (`YYYY-MM-DD`) as a half-open range on the
 * bare date column: `col >= from AND col < to + 1 day`. Unlike
 * `DATE(col) >= ...` this lets MySQL use an index on the column, and it
 * compares the stored wall-clock value, so no session/server time zone can
 * move an STO into a neighbouring day.
 */
function dateRangeConditions(fromDate, toDate) {
  const conditions = [];
  const params = [];
  if (fromDate) {
    conditions.push(`\`${HDR_DATE_COLUMN}\` >= ?`);
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push(`\`${HDR_DATE_COLUMN}\` < ?`);
    params.push(nextDay(toDate));
  }
  return { conditions, params };
}

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

  query(sql, params, code, ref = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.STOCK_TRANSFER_OUT",
            code: `REPOSITORY.STOCK_TRANSFER_OUT.${code}`,
            description: err.toString(),
            category: "",
            ref,
          });
          return reject(err);
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * Header rows only (no detail lines), newest first.
   *
   * @param {{ from_date?: string, to_date?: string, dn_ref_nos?: Array<number|string> }} [filters]
   *   `from_date` / `to_date` as `YYYY-MM-DD`, inclusive on `HDR_DATE_COLUMN`.
   *   `dn_ref_nos`, when given, restricts to those references (an empty list matches nothing).
   */
  async getHeaders(filters = {}) {
    const fromDate = trimmedOrNull(filters.from_date);
    const toDate = trimmedOrNull(filters.to_date);
    const { conditions, params } = dateRangeConditions(fromDate, toDate);
    const ref = { from_date: fromDate, to_date: toDate };

    if (!Array.isArray(filters.dn_ref_nos)) {
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      return this.query(
        `SELECT * FROM \`${HDR_TABLE}\` ${where} ORDER BY Dn_no DESC`,
        params,
        "GET",
        ref
      );
    }

    const refs = [...new Set(filters.dn_ref_nos.filter((r) => r != null))];
    if (refs.length === 0) return [];
    const parts = await Promise.all(
      chunk(refs).map((part) => {
        const where = [...conditions, `Dn_Ref_no IN (${part.map(() => "?").join(",")})`];
        return this.query(
          `SELECT * FROM \`${HDR_TABLE}\` WHERE ${where.join(" AND ")} ORDER BY Dn_no DESC`,
          [...params, ...part],
          "GET",
          ref
        );
      })
    );
    const rows = parts.flat();
    if (parts.length > 1) rows.sort((a, b) => Number(b.Dn_no) - Number(a.Dn_no));
    return rows;
  }

  /** Detail lines for the given Dn_no values, grouped `{ [Dn_no]: rows[] }`. */
  async getDetailsByDnNos(dnNos) {
    const unique = [...new Set((dnNos || []).filter((n) => n != null))];
    if (unique.length === 0) return {};
    const parts = await Promise.all(
      chunk(unique).map((part) =>
        this.query(
          `SELECT * FROM \`${DTL_TABLE}\` WHERE Dn_no IN (${part.map(() => "?").join(",")}) ORDER BY Dn_no, Dn_sl_no`,
          part,
          "GET_DTL"
        )
      )
    );
    return groupDetailsByDnNo(parts.flat());
  }

  /**
   * One row per STO in `[from_date, to_date]`: `{ date: 'YYYY-MM-DD', Dn_Ref_no }`.
   * The day is formatted by MySQL from the stored value, so it is the STO's own
   * calendar day and never passes through a JS Date / server time zone.
   */
  getCalendarRows(fromDate, toDate) {
    const { conditions, params } = dateRangeConditions(fromDate, toDate);
    return this.query(
      `SELECT DATE_FORMAT(\`${HDR_DATE_COLUMN}\`, '%Y-%m-%d') AS date, Dn_Ref_no
       FROM \`${HDR_TABLE}\`
       WHERE ${conditions.join(" AND ")}`,
      params,
      "GET_CALENDAR",
      { from_date: fromDate, to_date: toDate }
    );
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
module.exports.nextDay = nextDay;
module.exports.IN_CHUNK_SIZE = IN_CHUNK_SIZE;
