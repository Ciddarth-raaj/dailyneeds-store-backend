const GF_TABLE = "medishopdb_MED_DISTRIBUTOR_MAST";
const MASTER_TABLE = "product_distributor_master";

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function normalizeCid(value) {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * Medishop tables reference distributors by MDM_DIST_CODE (gofrugal).
 * Master details live in product_distributor_master keyed by cid.
 * Bridge: medishopdb_MED_DISTRIBUTOR_MAST.MDM_DIST_CODE -> cid -> product_distributor_master
 */
async function resolveByMedishopDistCodes(gofrugalDb, mainDb, distCodes) {
  const codes = [
    ...new Set(
      (distCodes || [])
        .map((c) => (c != null && c !== "" ? String(c) : null))
        .filter(Boolean)
    ),
  ];
  if (codes.length === 0) return {};

  const placeholders = codes.map(() => "?").join(",");
  const gfRows = await query(
    gofrugalDb,
    `SELECT MDM_DIST_CODE, cid FROM ${GF_TABLE} WHERE MDM_DIST_CODE IN (${placeholders})`,
    codes
  );

  const gfByCode = {};
  const cids = [];
  gfRows.forEach((r) => {
    const code = String(r.MDM_DIST_CODE);
    const cid = normalizeCid(r.cid);
    gfByCode[code] = { MDM_DIST_CODE: r.MDM_DIST_CODE, cid };
    if (cid) cids.push(cid);
  });

  const uniqueCids = [...new Set(cids)];
  const masterByCid = {};
  if (uniqueCids.length > 0) {
    const cidPlaceholders = uniqueCids.map(() => "?").join(",");
    const masterRows = await query(
      mainDb,
      `SELECT cid, mdm_dist_code, mdm_dist_name, mdm_short_name, mdm_tag
       FROM ${MASTER_TABLE} WHERE cid IN (${cidPlaceholders})`,
      uniqueCids
    );
    masterRows.forEach((r) => {
      masterByCid[normalizeCid(r.cid)] = r;
    });
  }

  const map = {};
  codes.forEach((code) => {
    const gf = gfByCode[code];
    if (!gf) {
      map[code] = null;
      return;
    }
    const cid = gf.cid;
    const master = cid ? masterByCid[cid] : null;
    map[code] = {
      MDM_DIST_CODE: gf.MDM_DIST_CODE,
      CID: cid || null,
      MDM_DIST_NAME: master?.mdm_dist_name ?? null,
      MDM_SHORT_NAME: master?.mdm_short_name ?? null,
      mdm_tag: master?.mdm_tag ?? null,
    };
  });
  return map;
}

/** Active distributors from master (mdm_tag = 'a') joined to medishop MDM_DIST_CODE via cid. */
async function getActiveWithMedishopCodes(gofrugalDb, mainDb) {
  const masterRows = await query(
    mainDb,
    `SELECT cid, mdm_dist_code, mdm_dist_name, mdm_short_name, mdm_tag
     FROM ${MASTER_TABLE} WHERE LOWER(mdm_tag) = 'a'`
  );
  const cids = masterRows
    .map((r) => normalizeCid(r.cid))
    .filter(Boolean);
  if (cids.length === 0) {
    return [];
  }

  const cidPlaceholders = cids.map(() => "?").join(",");
  const gfRows = await query(
    gofrugalDb,
    `SELECT MDM_DIST_CODE, cid FROM ${GF_TABLE} WHERE cid IN (${cidPlaceholders})`,
    cids
  );

  const gfRowsByCid = {};
  gfRows.forEach((r) => {
    const cid = normalizeCid(r.cid);
    if (!cid) return;
    if (!gfRowsByCid[cid]) gfRowsByCid[cid] = [];
    gfRowsByCid[cid].push(r);
  });

  const rows = [];
  masterRows.forEach((master) => {
    const cid = normalizeCid(master.cid);
    const gfList = gfRowsByCid[cid] || [];
    gfList.forEach((gf) => {
      rows.push({
        MDM_DIST_CODE: gf.MDM_DIST_CODE,
        CID: cid,
        MDM_DIST_NAME: master.mdm_dist_name,
        MDM_SHORT_NAME: master.mdm_short_name,
        mdm_tag: master.mdm_tag,
      });
    });
  });

  rows.sort((a, b) =>
    String(a.MDM_DIST_NAME || "").localeCompare(String(b.MDM_DIST_NAME || ""))
  );
  return rows;
}

module.exports = {
  GF_TABLE,
  MASTER_TABLE,
  resolveByMedishopDistCodes,
  getActiveWithMedishopCodes,
};
