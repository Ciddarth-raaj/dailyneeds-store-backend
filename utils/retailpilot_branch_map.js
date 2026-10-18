/**
 * RetailPilot store ID -> DNDS outlet, with Branch Master
 * (outlets.retailpilot_id) as the only source of the mapping.
 *
 * RetailPilot identifies a branch by a short, case-sensitive store slug. Nothing
 * here knows any slug: the map is built from the outlet rows each time, and
 * a slug no branch carries is an error, never a guess.
 */

class RetailPilotBranchMappingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RetailPilotBranchMappingError";
    this.code = code;
    this.details = details;
  }
}

const ERRORS = {
  STORE_ID_MISSING: "RETAILPILOT_STORE_ID_MISSING",
  STORE_UNMAPPED: "RETAILPILOT_STORE_UNMAPPED",
  MAP_EMPTY: "RETAILPILOT_BRANCH_MAP_EMPTY",
  DUPLICATE_ID: "RETAILPILOT_BRANCH_MAP_DUPLICATE",
};

/** Slugs are case-sensitive, so only surrounding spaces are removed. */
function normalizeStoreId(value) {
  if (value == null) return null;
  const id = String(value).trim();
  return id === "" ? null : id;
}

/**
 * @param rows outlet rows: { outlet_id, outlet_name, retailpilot_id }
 * @returns Map<store id, { outlet_id, outlet_name }>; rows without an ID are
 *   left out. Two branches with the same ID (the unique key should prevent
 *   it) is refused rather than resolved either way.
 */
function buildRetailPilotBranchMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = normalizeStoreId(row.retailpilot_id);
    if (id === null) continue;
    const outlet = { outlet_id: Number(row.outlet_id), outlet_name: row.outlet_name || null };
    const existing = map.get(id);
    if (existing && existing.outlet_id !== outlet.outlet_id) {
      throw new RetailPilotBranchMappingError(
        ERRORS.DUPLICATE_ID,
        `RetailPilot ID ${id} is set on two branches in Branch Master: outlet ${existing.outlet_id} and outlet ${outlet.outlet_id}`,
        { retailpilot_id: id, outlet_ids: [existing.outlet_id, outlet.outlet_id] }
      );
    }
    map.set(id, outlet);
  }
  return map;
}

/** The outlet for one RetailPilot store ID, or a RetailPilotBranchMappingError. */
function resolveOutletForStore(map, storeId) {
  const id = normalizeStoreId(storeId);
  if (id === null) {
    throw new RetailPilotBranchMappingError(ERRORS.STORE_ID_MISSING, "RetailPilot store ID is blank");
  }
  if (!map || map.size === 0) {
    throw new RetailPilotBranchMappingError(
      ERRORS.MAP_EMPTY,
      "No branch has a RetailPilot ID. Set it in Branch Master first.",
      { retailpilot_id: id }
    );
  }
  const outlet = map.get(id);
  if (!outlet) {
    throw new RetailPilotBranchMappingError(
      ERRORS.STORE_UNMAPPED,
      `RetailPilot store ${id} is not set as the RetailPilot ID of any branch in Branch Master`,
      { retailpilot_id: id }
    );
  }
  return outlet;
}

/** Plain { store id: outlet_id } object, for callers that only need the id. */
function toStoreIdObject(map) {
  const out = {};
  for (const [id, outlet] of map) out[id] = outlet.outlet_id;
  return out;
}

module.exports = {
  RetailPilotBranchMappingError,
  RETAILPILOT_BRANCH_MAP_ERRORS: ERRORS,
  normalizeStoreId,
  buildRetailPilotBranchMap,
  resolveOutletForStore,
  toStoreIdObject,
};
