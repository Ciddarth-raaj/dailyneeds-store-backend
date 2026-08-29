const TABLE = "product_sales";

function normalizeTranDate(tran_date) {
  if (tran_date == null) {
    return tran_date;
  }
  if (tran_date instanceof Date) {
    const y = tran_date.getFullYear();
    const m = tran_date.getMonth() + 1;
    const d = tran_date.getDate();
    const pad = (n) => (n < 10 ? "0" : "") + n;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  const str = String(tran_date).trim();
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : str;
}

function normalizeQty(tran_qty) {
  const n = Number(tran_qty);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : tran_qty;
}

function normalizeRow(r) {
  return {
    retail_outlet_id: Number(r.retail_outlet_id),
    product_id: parseInt(String(r.item_code), 10),
    tran_date: normalizeTranDate(r.tran_date),
    tran_qty: normalizeQty(r.tran_qty),
    tran_amt: Number(r.tran_amt),
    disc_amt: Number(r.disc_amt),
    gross_amt: Number(r.gross_amt),
    net_amt: Number(r.net_amt),
    profit: Number(r.profit),
  };
}

/**
 * @param {Array<{ retail_outlet_id: number, item_code: string|number, tran_date: string, tran_qty: number, tran_amt: number, disc_amt: number, gross_amt: number, net_amt: number, profit: number }>} rows
 */
class ProductSalesRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Total quantity sold per product over the trailing 3 calendar months,
   * divided by 3. Only products with at least one sale in the window are
   * returned.
   */
  listAvgSalesLast3Months() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT product_id, SUM(tran_qty) AS total_qty
         FROM \`${TABLE}\`
         WHERE tran_date >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
         GROUP BY product_id`,
        [],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(
            (rows || []).map((row) => ({
              product_id: row.product_id,
              avg_sales: Number(row.total_qty || 0) / 3,
            }))
          );
        }
      );
    });
  }

  updateAmounts(conn, row) {
    return new Promise((resolve, reject) => {
      conn.query(
        `UPDATE \`${TABLE}\`
         SET tran_amt = ?, disc_amt = ?, gross_amt = ?, net_amt = ?, profit = ?
         WHERE retail_outlet_id = ?
           AND product_id = ?
           AND tran_date = DATE(?)
           AND tran_qty = CAST(? AS DECIMAL(14, 4))`,
        [
          row.tran_amt,
          row.disc_amt,
          row.gross_amt,
          row.net_amt,
          row.profit,
          row.retail_outlet_id,
          row.product_id,
          row.tran_date,
          row.tran_qty,
        ],
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });
  }

  insertRow(conn, row) {
    return new Promise((resolve, reject) => {
      conn.query(
        `INSERT INTO \`${TABLE}\` (
          retail_outlet_id, product_id, tran_date, tran_qty,
          tran_amt, disc_amt, gross_amt, net_amt, profit
        ) VALUES (?, ?, DATE(?), CAST(? AS DECIMAL(14, 4)), ?, ?, ?, ?, ?)`,
        [
          row.retail_outlet_id,
          row.product_id,
          row.tran_date,
          row.tran_qty,
          row.tran_amt,
          row.disc_amt,
          row.gross_amt,
          row.net_amt,
          row.profit,
        ],
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });
  }

  bulkCreate(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0, updated: 0 });
        return;
      }

      const normalized = rows.map(normalizeRow);

      const productIds = [...new Set(normalized.map((r) => r.product_id))];
      if (productIds.some((id) => !Number.isFinite(id))) {
        resolve({
          code: 400,
          msg: "Invalid item_code: must be numeric product id",
        });
        return;
      }

      this.db.getConnection((errConn, conn) => {
        if (errConn) {
          return reject(errConn);
        }

        const finishErr = (e) => {
          conn.rollback(() => {
            conn.release();
            reject(e);
          });
        };

        const finishOk = (payload) => {
          conn.commit((errC) => {
            if (errC) {
              return conn.rollback(() => {
                conn.release();
                reject(errC);
              });
            }
            conn.release();
            resolve(payload);
          });
        };

        conn.beginTransaction(async (errTx) => {
          if (errTx) {
            conn.release();
            return reject(errTx);
          }

          try {
            const ph = productIds.map(() => "?").join(", ");
            const prodRows = await new Promise((res, rej) => {
              conn.query(
                `SELECT product_id FROM product_table WHERE product_id IN (${ph})`,
                productIds,
                (errSel, rowsOut) => {
                  if (errSel) rej(errSel);
                  else res(rowsOut || []);
                }
              );
            });

            const found = new Set(prodRows.map((row) => row.product_id));
            const missing = productIds.filter((id) => !found.has(id));
            if (missing.length) {
              return conn.rollback(() => {
                conn.release();
                resolve({
                  code: 400,
                  msg: `Unknown product_id(s) for item_code: ${missing.join(", ")}`,
                });
              });
            }

            let inserted = 0;
            let updated = 0;

            for (const row of normalized) {
              const updateResult = await this.updateAmounts(conn, row);

              if (updateResult.affectedRows > 0) {
                updated += 1;
                continue;
              }

              await this.insertRow(conn, row);
              inserted += 1;
            }

            finishOk({
              code: 200,
              inserted,
              updated,
            });
          } catch (err) {
            finishErr(err);
          }
        });
      });
    });
  }
}

module.exports = (db) => {
  return new ProductSalesRepository(db);
};
