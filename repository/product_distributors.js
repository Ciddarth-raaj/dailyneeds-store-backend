const logger = require("../utils/logger");

const GF_TABLE = "medishopdb_MED_DISTRIBUTOR_MAST";
const MAP_TABLE = "product_distributor";
const MASTER_TABLE = "product_distributor_master";

class ProductDistributorsRepository {
  constructor(gofrugalDb, mainDb) {
    this.gofrugalDb = gofrugalDb;
    this.mainDb = mainDb;
  }

  _formatRow(row, medishopCode = null) {
    return {
      CID: row.cid,
      MDM_DIST_CODE: medishopCode,
      HQ_DIST_CODE: row.mdm_dist_code,
      MDM_DIST_NAME: row.mdm_dist_name,
      MDM_SHORT_NAME: row.mdm_short_name,
      buyer_id: row.buyer_id ?? null,
      buyer_name: row.buyer_name ?? null,
    };
  }

  _getMedishopDistCodeByCid(cid) {
    return new Promise((resolve, reject) => {
      const key = String(cid).trim();
      this.gofrugalDb.query(
        `SELECT MDM_DIST_CODE FROM ${GF_TABLE} WHERE TRIM(cid) = ? LIMIT 1`,
        [key],
        (err, rows) => {
          if (err) return reject(err);
          const code =
            rows && rows[0] && rows[0].MDM_DIST_CODE != null
              ? String(rows[0].MDM_DIST_CODE)
              : null;
          resolve(code);
        }
      );
    });
  }

  _getMedishopCodesByCids(cids) {
    return new Promise((resolve, reject) => {
      const keys = [
        ...new Set(
          (cids || [])
            .map((c) => (c != null ? String(c).trim() : ""))
            .filter(Boolean)
        ),
      ];
      if (keys.length === 0) return resolve({});

      const placeholders = keys.map(() => "?").join(",");
      this.gofrugalDb.query(
        `SELECT MDM_DIST_CODE, cid FROM ${GF_TABLE} WHERE TRIM(cid) IN (${placeholders})`,
        keys,
        (err, rows) => {
          if (err) return reject(err);
          const map = {};
          (rows || []).forEach((r) => {
            const cid = r.cid != null ? String(r.cid).trim() : "";
            if (!cid || map[cid]) return;
            map[cid] = String(r.MDM_DIST_CODE);
          });
          resolve(map);
        }
      );
    });
  }

  _getBuyerMapByCids(cids) {
    return new Promise((resolve, reject) => {
      const keys = [
        ...new Set(
          (cids || [])
            .map((c) => (c != null ? String(c).trim() : ""))
            .filter(Boolean)
        ),
      ];
      if (keys.length === 0) return resolve({});

      const placeholders = keys.map(() => "?").join(",");
      this.mainDb.query(
        `SELECT pd.cid, pd.buyer_id, ne.employee_name AS buyer_name
         FROM ${MAP_TABLE} pd
         LEFT JOIN new_employee ne ON ne.employee_id = pd.buyer_id
         WHERE pd.cid IN (${placeholders})`,
        keys,
        (err, rows) => {
          if (err) return reject(err);
          const map = {};
          (rows || []).forEach((b) => {
            const cid = b.cid != null ? String(b.cid).trim() : "";
            if (cid) map[cid] = b;
          });
          resolve(map);
        }
      );
    });
  }

  /**
   * All distributors from product_distributor_master with buyer map via cid.
   * MDM_DIST_CODE is the medishop code (for purchase ack/return); HQ_DIST_CODE is from master import.
   */
  getAll() {
    return new Promise((resolve, reject) => {
      this.mainDb.query(
        `SELECT pdm.cid, pdm.mdm_dist_code, pdm.mdm_dist_name, pdm.mdm_short_name
         FROM ${MASTER_TABLE} pdm
         ORDER BY pdm.mdm_dist_name`,
        (err, masterRows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }

          const rows = masterRows || [];
          const cids = rows
            .map((r) => (r.cid != null ? String(r.cid).trim() : ""))
            .filter(Boolean);

          if (cids.length === 0) return resolve([]);

          Promise.all([
            this._getBuyerMapByCids(cids),
            this._getMedishopCodesByCids(cids),
          ])
            .then(([buyerByCid, medishopByCid]) => {
              const data = rows.map((row) => {
                const cid = String(row.cid).trim();
                const buyer = buyerByCid[cid];
                return this._formatRow(
                  {
                    ...row,
                    buyer_id: buyer ? buyer.buyer_id : null,
                    buyer_name: buyer ? buyer.buyer_name : null,
                  },
                  medishopByCid[cid] ?? null
                );
              });
              resolve(data);
            })
            .catch(reject);
        }
      );
    });
  }

  getByCid(cid) {
    const key = String(cid).trim();
    return new Promise((resolve, reject) => {
      this.mainDb.query(
        `SELECT pdm.cid, pdm.mdm_dist_code, pdm.mdm_dist_name, pdm.mdm_short_name,
                pd.buyer_id, ne.employee_name AS buyer_name
         FROM ${MASTER_TABLE} pdm
         LEFT JOIN ${MAP_TABLE} pd ON pd.cid = pdm.cid
         LEFT JOIN new_employee ne ON ne.employee_id = pd.buyer_id
         WHERE pdm.cid = ?`,
        [key],
        (err, rows) => {
          if (err) return reject(err);
          const row = rows && rows[0] ? rows[0] : null;
          if (!row) return resolve(null);

          this._getMedishopDistCodeByCid(key)
            .then((medishopCode) => resolve(this._formatRow(row, medishopCode)))
            .catch(reject);
        }
      );
    });
  }

  /**
   * Insert or update buyer mapping keyed by cid.
   */
  upsertBuyerMap(cid, buyer_id) {
    const key = String(cid).trim();
    const bid = buyer_id == null ? null : buyer_id;

    return new Promise((resolve, reject) => {
      this.mainDb.query(
        `UPDATE ${MAP_TABLE}
         SET buyer_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE cid = ?`,
        [bid, key],
        (updateErr, updateRes) => {
          if (updateErr) return reject(updateErr);
          if (updateRes.affectedRows > 0) {
            return resolve({ code: 200, CID: key, buyer_id: bid });
          }

          this._getMedishopDistCodeByCid(key)
            .then((medishopCode) => {
              if (!medishopCode) {
                const err = new Error(
                  `No medishop distributor found for CID: ${key}`
                );
                err.statusCode = 404;
                throw err;
              }

              return new Promise((res, rej) => {
                this.mainDb.query(
                  `INSERT INTO ${MAP_TABLE} (mdm_dist_code, cid, buyer_id) VALUES (?, ?, ?)
                   ON DUPLICATE KEY UPDATE
                    cid = VALUES(cid),
                    buyer_id = VALUES(buyer_id),
                    updated_at = CURRENT_TIMESTAMP`,
                  [medishopCode, key, bid],
                  (insertErr) => (insertErr ? rej(insertErr) : res())
                );
              });
            })
            .then(() => resolve({ code: 200, CID: key, buyer_id: bid }))
            .catch(reject);
        }
      );
    });
  }

  bulkUpsertBuyerMap(items) {
    return new Promise((resolve, reject) => {
      if (!items || items.length === 0) {
        return resolve({ code: 200, count: 0 });
      }

      (async () => {
        try {
          const byCid = new Map();
          items.forEach((row) => {
            const key = String(row.CID).trim();
            const bid = row.buyer_id == null ? null : row.buyer_id;
            byCid.set(key, bid);
          });

          let count = 0;
          for (const [key, bid] of byCid.entries()) {
            await this.upsertBuyerMap(key, bid);
            count++;
          }
          resolve({ code: 200, count });
        } catch (err) {
          reject(err);
        }
      })();
    });
  }

  bulkHqImport(items) {
    return new Promise((resolve, reject) => {
      if (!items || items.length === 0) {
        return resolve({ code: 200, count: 0 });
      }

      const rows = items;
      const placeholders = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const values = rows.flatMap((row) => [
        row.cid,
        row.mdm_dist_code,
        row.mdm_dist_name ?? null,
        row.mdm_short_name ?? null,
        row.mdm_tag ?? null,
      ]);

      this.mainDb.query(
        `INSERT INTO ${MASTER_TABLE}
          (cid, mdm_dist_code, mdm_dist_name, mdm_short_name, mdm_tag)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
          mdm_dist_code = VALUES(mdm_dist_code),
          mdm_dist_name = VALUES(mdm_dist_name),
          mdm_short_name = VALUES(mdm_short_name),
          mdm_tag = VALUES(mdm_tag),
          updated_at = CURRENT_TIMESTAMP`,
        values,
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.BULK_HQ_IMPORT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, count: rows.length });
        }
      );
    });
  }

  delete(cid) {
    const key = String(cid).trim();
    return this._getMedishopDistCodeByCid(key).then((medishopCode) => {
      const sql = medishopCode
        ? `DELETE FROM ${MAP_TABLE} WHERE cid = ? OR mdm_dist_code = ?`
        : `DELETE FROM ${MAP_TABLE} WHERE cid = ?`;
      const params = medishopCode ? [key, medishopCode] : [key];

      return new Promise((resolve, reject) => {
        this.mainDb.query(sql, params, (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        });
      });
    });
  }
}

module.exports = (gofrugalDb, mainDb) => {
  return new ProductDistributorsRepository(gofrugalDb, mainDb);
};
