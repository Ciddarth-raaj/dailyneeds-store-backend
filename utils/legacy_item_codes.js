/**
 * Old (GoFrugal / Delium) item codes <-> our product ids.
 *
 * product_table.product_id is RetailPilot's article id; the code an item had
 * before is kept in product_table.legacy_code. The frozen GoFrugal copy
 * (medishopdb_*) and anything else from before RetailPilot still carries the
 * old code, so every read of it goes through here.
 */

const CHUNK = 1000;

function toCode(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function query(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function lookup(db, values, fromCol, toCol) {
  const unique = [...new Set((values || []).map(toCode).filter((v) => v != null))];
  const map = new Map();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const rows = await query(
      db,
      `SELECT ${fromCol} AS f, ${toCol} AS t FROM product_table
        WHERE ${fromCol} IN (${part.map(() => "?").join(",")})`,
      part
    );
    // A product with no old code (new in RetailPilot) has none to give.
    rows.forEach((r) => {
      if (r.t != null) map.set(Number(r.f), Number(r.t));
    });
  }
  return map;
}

/** Map<old code, product id> */
const legacyToProductIds = (db, codes) => lookup(db, codes, "legacy_code", "product_id");
/** Map<product id, old code> */
const productIdsToLegacy = (db, ids) => lookup(db, ids, "product_id", "legacy_code");

/**
 * Replace an old code in each row's `field` with the product id it now has.
 * A code with no product left as it is (so it still shows, unmatched).
 */
async function rewriteLegacyCodes(db, rows, field) {
  if (!rows || !rows.length) return rows;
  const map = await legacyToProductIds(db, rows.map((r) => r[field]));
  for (const r of rows) {
    const code = toCode(r[field]);
    if (code != null && map.has(code)) r[field] = map.get(code);
  }
  return rows;
}

module.exports = { legacyToProductIds, productIdsToLegacy, rewriteLegacyCodes };
