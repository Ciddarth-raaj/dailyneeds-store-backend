const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { OLD_TAG, isRpCid, guard } = require("../utils/retailpilot_suppliers");

const MASTER = "product_distributor_master";
const BUYERS = "product_distributor";
const CHUNK = 500;

const chunks = (list, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const marks = (n) => new Array(n).fill("?").join(",");

/**
 * Writes the RetailPilot supplier switch (utils/retailpilot_suppliers.js) in
 * ONE transaction: everything or nothing. A dry run does every step and then
 * rolls back, so its counts are what a real run would do.
 */
class RetailPilotSuppliersRepository {
  constructor(db) {
    this.db = db;
  }

  /** How many RetailPilot suppliers DNDS has (0 until the first switch). */
  async countRetailPilotSuppliers() {
    const rows = await new Promise((resolve, reject) =>
      this.db.query(`SELECT COUNT(*) AS n FROM ${MASTER} WHERE cid LIKE 'RP%'`, [], (err, r) => (err ? reject(err) : resolve(r)))
    );
    return Number(rows[0].n) || 0;
  }

  /**
   * @param rows      supplier rows (supplierRows().rows)
   * @param supplierOf Map<retailpilot article id, cid>
   */
  async apply(rows, supplierOf, { dryRun = false } = {}) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const q = (sql, params) => queryAsync(conn, sql, params);

      // 1. What DNDS has now; refuse a pull that would wipe the list.
      const existing = await q(`SELECT cid, mdm_dist_code, mdm_tag FROM ${MASTER}`);
      const existingCids = new Set(existing.map((r) => String(r.cid)));
      const refusal = guard(rows.length, existing.filter((r) => isRpCid(r.cid)).length);
      if (refusal) {
        await rollbackAsync(conn);
        return { code: 409, msg: refusal };
      }
      const current = new Set(rows.map((r) => r.cid));

      // 2. RetailPilot's suppliers in; buyer and holding days left as they are.
      for (const part of chunks(rows)) {
        await q(
          `INSERT INTO ${MASTER} (cid, mdm_dist_code, mdm_dist_name, mdm_short_name, mdm_tag)
           VALUES ${part.map(() => "(?, ?, ?, ?, ?)").join(", ")}
           ON DUPLICATE KEY UPDATE
             mdm_dist_code = VALUES(mdm_dist_code),
             mdm_dist_name = VALUES(mdm_dist_name),
             mdm_short_name = VALUES(mdm_short_name),
             mdm_tag = VALUES(mdm_tag)`,
          part.flatMap((r) => [r.cid, r.mdm_dist_code, r.mdm_dist_name, r.mdm_short_name, r.mdm_tag])
        );
      }

      // 3. Each product's supplier from RetailPilot; none there: blank.
      const products = await q(`SELECT product_id, retailpilot_article_id, distributor_id FROM product_table`);
      const moves = new Map(); // target cid ("" = blank) -> product ids
      let productsSet = 0;
      let productsCleared = 0;
      for (const p of products) {
        const article = p.retailpilot_article_id == null ? "" : String(p.retailpilot_article_id);
        const want = (article && supplierOf.get(article)) || "";
        const have = p.distributor_id == null ? "" : String(p.distributor_id);
        if (want === have) continue;
        if (!moves.has(want)) moves.set(want, []);
        moves.get(want).push(p.product_id);
        if (want) productsSet += 1;
        else productsCleared += 1;
      }
      for (const [target, ids] of moves) {
        for (const part of chunks(ids)) {
          await q(`UPDATE product_table SET distributor_id = ? WHERE product_id IN (${marks(part.length)})`, [
            target || null,
            ...part,
          ]);
        }
      }

      // 4. Buyers of suppliers that are no longer in the list (start fresh).
      const buyers = await q(`SELECT mdm_dist_code, cid FROM ${BUYERS}`);
      const staleBuyers = buyers.filter((b) => !current.has(b.cid == null ? "" : String(b.cid))).map((b) => b.mdm_dist_code);
      for (const part of chunks(staleBuyers)) {
        await q(`DELETE FROM ${BUYERS} WHERE mdm_dist_code IN (${marks(part.length)})`, part);
      }

      // 5. Suppliers no longer in RetailPilot: delete; keep (hidden) the
      //    ones history refers to.
      const leftovers = existing.filter((r) => !current.has(String(r.cid)));
      const used = new Set();
      for (const table of ["advance_requests", "credit_purchases", "lr_followup"]) {
        const refs = await q(`SELECT DISTINCT distributor_code FROM ${table} WHERE distributor_code IS NOT NULL`);
        refs.forEach((r) => used.add(String(r.distributor_code)));
      }
      const hide = leftovers.filter((r) => used.has(String(r.mdm_dist_code)));
      const drop = leftovers.filter((r) => !used.has(String(r.mdm_dist_code)));
      for (const part of chunks(hide.map((r) => r.cid))) {
        await q(`UPDATE ${MASTER} SET mdm_tag = ? WHERE cid IN (${marks(part.length)})`, [OLD_TAG, ...part]);
      }
      for (const part of chunks(drop.map((r) => r.cid))) {
        await q(`DELETE FROM ${MASTER} WHERE cid IN (${marks(part.length)})`, part);
      }

      const result = {
        code: 200,
        dry_run: !!dryRun,
        suppliers: rows.length,
        suppliers_new: rows.filter((r) => !existingCids.has(r.cid)).length,
        products_supplier_set: productsSet,
        products_supplier_cleared: productsCleared,
        buyers_removed: staleBuyers.length,
        old_suppliers_deleted: drop.length,
        old_suppliers_hidden: hide.length,
      };
      if (dryRun) await rollbackAsync(conn);
      else await commitAsync(conn);
      return result;
    } catch (err) {
      try {
        await rollbackAsync(conn);
      } catch (e) {
        /* the original error is the one to report */
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = (db) => new RetailPilotSuppliersRepository(db);
