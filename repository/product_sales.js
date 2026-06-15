const TABLE = "product_sales";
const PRODUCT_OFFERS = "product_offers";

/**
 * @param {Array<{ retail_outlet_id: number, item_code: string|number, tran_date: string, tran_qty: number, tran_amt: number, disc_amt: number, gross_amt: number, net_amt: number, profit: number }>} rows
 */
class ProductSalesRepository {
  constructor(db) {
    this.db = db;
  }

  bulkCreate(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      const normalized = rows.map((r) => ({
        retail_outlet_id: r.retail_outlet_id,
        item_code: String(r.item_code),
        tran_date: r.tran_date,
        tran_qty: Number(r.tran_qty),
        tran_amt: Number(r.tran_amt),
        disc_amt: Number(r.disc_amt),
        gross_amt: Number(r.gross_amt),
        net_amt: Number(r.net_amt),
        profit: Number(r.profit),
      }));

      const productIds = [
        ...new Set(
          normalized.map((r) => parseInt(String(r.item_code), 10))
        ),
      ];
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

        conn.beginTransaction((errTx) => {
          if (errTx) {
            conn.release();
            return reject(errTx);
          }

          const ph = productIds.map(() => "?").join(", ");
          conn.query(
            `SELECT product_id FROM product_table WHERE product_id IN (${ph})`,
            productIds,
            (errSel, prodRows) => {
              if (errSel) {
                return finishErr(errSel);
              }
              const found = new Set((prodRows || []).map((row) => row.product_id));
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

              const valueTuples = normalized.map((r) => {
                const pid = parseInt(String(r.item_code), 10);
                return [
                  r.retail_outlet_id,
                  pid,
                  r.tran_date,
                  r.tran_qty,
                  r.tran_amt,
                  r.disc_amt,
                  r.gross_amt,
                  r.net_amt,
                  r.profit,
                ];
              });
              const insPh = valueTuples
                .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .join(", ");
              const flatIns = valueTuples.flat();

              conn.query(
                `INSERT INTO \`${TABLE}\` (retail_outlet_id, product_id, tran_date, tran_qty, tran_amt, disc_amt, gross_amt, net_amt, profit) VALUES ${insPh}`,
                flatIns,
                (errIns) => {
                  if (errIns) {
                    return finishErr(errIns);
                  }

                  const deltas = new Map();
                  normalized.forEach((r) => {
                    const pid = parseInt(String(r.item_code), 10);
                    const q = Number(r.tran_qty);
                    if (Number.isFinite(q)) {
                      deltas.set(pid, (deltas.get(pid) || 0) + q);
                    }
                  });

                  const entries = [...deltas.entries()];
                  const runUpdate = (idx) => {
                    if (idx >= entries.length) {
                      return finishOk({
                        code: 200,
                        inserted: normalized.length,
                        product_ids: productIds,
                      });
                    }
                    const [pid, delta] = entries[idx];
                    conn.query(
                      `UPDATE \`${PRODUCT_OFFERS}\` SET stock_output = stock_output + ? WHERE product_id = ?`,
                      [delta, pid],
                      (errUp) => {
                        if (errUp) {
                          return finishErr(errUp);
                        }
                        runUpdate(idx + 1);
                      }
                    );
                  };
                  runUpdate(0);
                }
              );
            }
          );
        });
      });
    });
  }
}

module.exports = (db) => {
  return new ProductSalesRepository(db);
};
