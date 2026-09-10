const logger = require("../utils/logger");

const GROUPS_TABLE = "offers_v3_talker_groups";
const GROUP_ITEMS_TABLE = "offers_v3_talker_group_items";
const LOCATIONS_TABLE = "offers_v3_talker_group_locations";
const PROOFS_TABLE = "offers_v3_talker_proofs";
const PROOF_IMAGES_TABLE = "offers_v3_talker_proof_images";
const EDIT_LOG_TABLE = "offers_v3_talker_group_edit_log";
const PRINT_SETTINGS_TABLE = "offers_v3_talker_print_settings";

const BULK_CHUNK_SIZE = 1000;

/**
 * Articles currently carrying an offer, from both routes an offer can arrive
 * by: an item-level offer, or a batch-level price drop. UNION dedupes an
 * article that has both, so this is one row per item_code.
 */
const ACTIVE_OFFER_ARTICLES_SQL = `
  SELECT item_code FROM \`offers_v3_item\` WHERE status = 'active'
  UNION
  SELECT item_code FROM \`offers_v3_batch\` WHERE status IN ('active', 'zero_stock_flagged')
`;

/**
 * The one offer an article is shown as carrying, as a single sortable string.
 *
 * An article can hold an item-level offer and several batch offers at once, so
 * the type and the value have to be picked from the *same* offer: maxed
 * independently they could pair a type from one with a value from another and
 * report an offer nobody made. MySQL 5.7 has no window functions, so the row
 * is chosen by encoding it - item-level first, then type, then value - and
 * taking MAX(), the same trick used for latest-GRN pricing.
 *
 * CONCAT yields NULL if any part is NULL, so a row with no offer simply loses.
 */
const OFFER_PICK_SQL = `
  MAX(CONCAT(
    IF(oi.offer_type IS NOT NULL, '1', '0'),
    RPAD(COALESCE(oi.offer_type, ob.offer_type), 12, ' '),
    LPAD(CAST(ROUND(COALESCE(oi.value, ob.value) * 100) AS CHAR), 14, '0')
  ))
`;

const OFFER_TYPE_FROM_PICK = `TRIM(SUBSTRING(${OFFER_PICK_SQL}, 2, 12))`;
const OFFER_VALUE_FROM_PICK = `CAST(SUBSTRING(${OFFER_PICK_SQL}, 14) AS DECIMAL(16, 2)) / 100`;

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function logError(code, description, ref = {}) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "REPOSITORY.OFFERS_V3_TALKER",
    code,
    description,
    category: "",
    ref,
  });
}

class OffersV3TalkerRepository {
  constructor(db) {
    this.db = db;
  }

  _query(sql, params, code, ref = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logError(code, err.toString(), ref);
          return reject(err);
        }
        resolve(rows);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------

  async listGroups({ status, search, group_type } = {}) {
    const where = [];
    const params = [];
    if (status) {
      where.push("g.status = ?");
      params.push(status);
    }
    // Individual signs can outnumber brand groups many times over, so the list
    // has to be filterable by type or the brand blocks get lost in them.
    if (group_type) {
      where.push("g.group_type = ?");
      params.push(group_type);
    }
    if (search) {
      where.push("(g.label LIKE ? OR g.supplier LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this._query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM \`${GROUP_ITEMS_TABLE}\` gi WHERE gi.group_id = g.id) AS item_count,
              (SELECT COUNT(*) FROM \`${LOCATIONS_TABLE}\` gl WHERE gl.group_id = g.id AND gl.active = 1) AS location_count
       FROM \`${GROUPS_TABLE}\` g
       ${whereSql}
       ORDER BY g.status ASC, g.label ASC`,
      params,
      "LIST_GROUPS"
    );
  }

  async getGroupById(id) {
    const rows = await this._query(
      `SELECT * FROM \`${GROUPS_TABLE}\` WHERE id = ?`,
      [id],
      "GET_GROUP",
      { id }
    );
    return rows && rows[0] ? rows[0] : null;
  }

  listGroupItems(group_id) {
    return this._query(
      `SELECT gi.item_code, pt.de_name AS item_name
       FROM \`${GROUP_ITEMS_TABLE}\` gi
       LEFT JOIN product_table pt ON pt.product_id = gi.item_code
       WHERE gi.group_id = ?
       ORDER BY gi.item_code ASC`,
      [group_id],
      "LIST_GROUP_ITEMS",
      { group_id }
    );
  }

  async createGroup(data) {
    const res = await this._query(
      `INSERT INTO \`${GROUPS_TABLE}\`
        (label, group_type, origin, status, supplier, markdown_pct, talker_text,
         expected_price, expected_pct_off, active_from, active_to, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.label,
        data.group_type || "group",
        data.origin || "manual",
        data.status || "draft",
        data.supplier ?? null,
        data.markdown_pct ?? null,
        data.talker_text ?? null,
        data.expected_price ?? null,
        data.expected_pct_off ?? null,
        data.active_from ?? null,
        data.active_to ?? null,
        data.created_by ?? null,
      ],
      "CREATE_GROUP"
    );
    return res.insertId;
  }

  async updateGroup(id, fields) {
    const allowed = [
      "label",
      "group_type",
      "status",
      "supplier",
      "markdown_pct",
      "talker_text",
      "expected_price",
      "expected_pct_off",
      "active_from",
      "active_to",
    ];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`\`${key}\` = ?`);
        params.push(fields[key]);
      }
    }
    if (!sets.length) {
      return { affectedRows: 0 };
    }
    params.push(id);
    const res = await this._query(
      `UPDATE \`${GROUPS_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
      params,
      "UPDATE_GROUP",
      { id }
    );
    return { affectedRows: res.affectedRows };
  }

  async deleteGroup(id) {
    const res = await this._query(
      `DELETE FROM \`${GROUPS_TABLE}\` WHERE id = ? AND status = 'draft'`,
      [id],
      "DELETE_GROUP",
      { id }
    );
    return { affectedRows: res.affectedRows };
  }

  /**
   * What deleting these groups would take with them. Groups cascade to their
   * articles, their per-outlet shelf locations, and every photo round attached
   * to those locations - so the count has to be shown before anyone confirms,
   * not reported after the fact.
   */
  async countGroupCascade(ids) {
    if (!ids || !ids.length) {
      return { groups: 0, items: 0, locations: 0, proofs: 0, images: 0 };
    }
    // Aliased group_count, not groups: GROUPS is a reserved word in MySQL 8 and
    // an unquoted alias is a parse error there. MariaDB accepts it, so this only
    // ever failed in production.
    const rows = await this._query(
      `SELECT
        (SELECT COUNT(*) FROM \`${GROUPS_TABLE}\` WHERE id IN (?)) AS group_count,
        (SELECT COUNT(*) FROM \`${GROUP_ITEMS_TABLE}\` WHERE group_id IN (?)) AS items,
        (SELECT COUNT(*) FROM \`${LOCATIONS_TABLE}\` WHERE group_id IN (?)) AS locations,
        (SELECT COUNT(*) FROM \`${PROOFS_TABLE}\` p
           JOIN \`${LOCATIONS_TABLE}\` l ON l.id = p.location_id
          WHERE l.group_id IN (?)) AS proofs,
        (SELECT COUNT(*) FROM \`${PROOF_IMAGES_TABLE}\` pi
           JOIN \`${PROOFS_TABLE}\` p ON p.id = pi.proof_id
           JOIN \`${LOCATIONS_TABLE}\` l ON l.id = p.location_id
          WHERE l.group_id IN (?)) AS images`,
      [ids, ids, ids, ids, ids],
      "COUNT_GROUP_CASCADE"
    );
    const row = rows[0];
    return {
      groups: row.group_count,
      items: row.items,
      locations: row.locations,
      proofs: row.proofs,
      images: row.images,
    };
  }

  /**
   * Unlike deleteGroup this does not care about status: a full reset has to be
   * able to clear published and ended groups too.
   */
  async deleteGroups(ids) {
    if (!ids || !ids.length) return { affectedRows: 0 };
    // No foreign key ties the edit log to a group, so its rows would survive as
    // history pointing at groups that no longer exist.
    await this._query(
      `DELETE FROM \`${EDIT_LOG_TABLE}\` WHERE group_id IN (?)`,
      [ids],
      "DELETE_EDIT_LOG"
    );
    const res = await this._query(
      `DELETE FROM \`${GROUPS_TABLE}\` WHERE id IN (?)`,
      [ids],
      "DELETE_GROUPS"
    );
    return { affectedRows: res.affectedRows };
  }

  // ---------------------------------------------------------------------
  // Group membership
  // ---------------------------------------------------------------------

  /**
   * An article belongs to at most one group (enforced by a unique key on
   * item_code), so adding to a new group moves it off its previous one.
   */
  async addItemsToGroup(group_id, item_codes) {
    if (!item_codes || !item_codes.length) {
      return { added: 0 };
    }
    let added = 0;
    for (const batch of chunk(item_codes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "(?, ?)").join(", ");
      const params = batch.flatMap((code) => [group_id, code]);
      const res = await this._query(
        `INSERT INTO \`${GROUP_ITEMS_TABLE}\` (group_id, item_code) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE group_id = VALUES(group_id)`,
        params,
        "ADD_ITEMS",
        { group_id }
      );
      added += res.affectedRows;
    }
    return { added };
  }

  async removeItemsFromGroup(group_id, item_codes) {
    if (!item_codes || !item_codes.length) {
      return { removed: 0 };
    }
    let removed = 0;
    for (const batch of chunk(item_codes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      const res = await this._query(
        `DELETE FROM \`${GROUP_ITEMS_TABLE}\` WHERE group_id = ? AND item_code IN (${placeholders})`,
        [group_id, ...batch],
        "REMOVE_ITEMS",
        { group_id }
      );
      removed += res.affectedRows;
    }
    return { removed };
  }

  /** Merge: repoint every item on `from` to `to`, then drop the empty group. */
  async mergeGroups(from_group_id, to_group_id) {
    await this._query(
      `UPDATE IGNORE \`${GROUP_ITEMS_TABLE}\` SET group_id = ? WHERE group_id = ?`,
      [to_group_id, from_group_id],
      "MERGE_ITEMS",
      { from_group_id, to_group_id }
    );
    await this._query(
      `DELETE FROM \`${GROUP_ITEMS_TABLE}\` WHERE group_id = ?`,
      [from_group_id],
      "MERGE_CLEANUP",
      { from_group_id }
    );
    await this._query(
      `DELETE FROM \`${GROUPS_TABLE}\` WHERE id = ?`,
      [from_group_id],
      "MERGE_DROP_GROUP",
      { from_group_id }
    );
    return { code: 200 };
  }

  // ---------------------------------------------------------------------
  // Auto-derivation inputs
  // ---------------------------------------------------------------------

  /**
   * The pool a group can be built from: articles on offer that aren't already
   * in one. Not a gap to be closed - an article on offer is individual by
   * default and needs no sign - so this is a picker, not an alert.
   *
   * Excludes membership of any group, draft included: an article sitting in a
   * draft someone is still assembling is already spoken for, and offering it
   * again would silently move it out of that draft.
   */
  listUngroupedArticles() {
    return this._query(
      `SELECT a.item_code, pt.de_name AS item_name,
              MAX(pci.de_distributor) AS supplier,
              ${OFFER_TYPE_FROM_PICK} AS offer_type,
              ${OFFER_VALUE_FROM_PICK} AS value
       FROM (${ACTIVE_OFFER_ARTICLES_SQL}) a
       LEFT JOIN product_table pt ON pt.product_id = a.item_code
       LEFT JOIN \`offers_v3_item\` oi ON oi.item_code = a.item_code AND oi.status = 'active'
       LEFT JOIN \`offers_v3_batch\` ob ON ob.item_code = a.item_code
            AND ob.status IN ('active', 'zero_stock_flagged')
       LEFT JOIN price_checker_items pci ON pci.product_id = a.item_code
       LEFT JOIN \`${GROUP_ITEMS_TABLE}\` gi ON gi.item_code = a.item_code
       WHERE gi.group_id IS NULL
       GROUP BY a.item_code, pt.de_name
       ORDER BY a.item_code ASC`,
      [],
      "LIST_UNGROUPED"
    );
  }

  /**
   * Every article currently on offer, with the group it already belongs to (if
   * any). This is the only valid pool for talker group membership - a talker
   * advertises an offer, so an article with no offer has no sign.
   */
  listOfferArticles() {
    // Carries the offer itself, not just the article: a group talker shows one
    // offer, so whoever builds one has to be able to see - and the server has
    // to be able to check - that the selection agrees.
    return this._query(
      `SELECT a.item_code, pt.de_name AS item_name,
              MAX(pci.de_distributor) AS supplier,
              ${OFFER_TYPE_FROM_PICK} AS offer_type,
              ${OFFER_VALUE_FROM_PICK} AS value,
              MAX(gi.group_id) AS group_id,
              MAX(g.label) AS group_label,
              MAX(g.status) AS group_status
       FROM (${ACTIVE_OFFER_ARTICLES_SQL}) a
       LEFT JOIN product_table pt ON pt.product_id = a.item_code
       LEFT JOIN \`offers_v3_item\` oi ON oi.item_code = a.item_code AND oi.status = 'active'
       LEFT JOIN \`offers_v3_batch\` ob ON ob.item_code = a.item_code
            AND ob.status IN ('active', 'zero_stock_flagged')
       LEFT JOIN price_checker_items pci ON pci.product_id = a.item_code
       LEFT JOIN \`${GROUP_ITEMS_TABLE}\` gi ON gi.item_code = a.item_code
       LEFT JOIN \`${GROUPS_TABLE}\` g ON g.id = gi.group_id
       GROUP BY a.item_code, pt.de_name
       ORDER BY pt.de_name ASC`,
      [],
      "LIST_OFFER_ARTICLES"
    );
  }

  /**
   * Everything a printed shelf talker needs, one row per article in a group.
   *
   * The three printed wordings are all derived from the offer itself - a
   * percentage, a rupees-off, or a special price - so none of them needs the
   * per-outlet selling price. That is what makes one print run valid for every
   * outlet: nothing outlet-specific ends up on the card.
   *
   * offer_type and value are taken as a pair from the item-level offer when
   * there is one, falling back to the batch offer, rather than maxed
   * independently - a type from one offer and a value from another would print
   * a wrong sign.
   */
  listPrintData({ status, group_type } = {}) {
    const where = ["g.status <> 'ended'"];
    const params = [];
    if (status) {
      where.push("g.status = ?");
      params.push(status);
    }
    if (group_type) {
      where.push("g.group_type = ?");
      params.push(group_type);
    }
    return this._query(
      `SELECT g.id AS group_id, g.label, g.group_type, g.status, g.supplier,
              g.talker_text, g.active_to,
              gi.item_code, pt.de_name AS item_name,
              COALESCE(MAX(oi.offer_type), MAX(ob.offer_type)) AS offer_type,
              COALESCE(MAX(oi.value), MAX(ob.value)) AS value
       FROM \`${GROUPS_TABLE}\` g
       JOIN \`${GROUP_ITEMS_TABLE}\` gi ON gi.group_id = g.id
       LEFT JOIN product_table pt ON pt.product_id = gi.item_code
       LEFT JOIN \`offers_v3_item\` oi ON oi.item_code = gi.item_code AND oi.status = 'active'
       LEFT JOIN \`offers_v3_batch\` ob ON ob.item_code = gi.item_code
            AND ob.status IN ('active', 'zero_stock_flagged')
       WHERE ${where.join(" AND ")}
       GROUP BY g.id, g.label, g.group_type, g.status, g.supplier, g.talker_text,
                g.active_to, gi.item_code, pt.de_name
       ORDER BY g.label ASC, pt.de_name ASC`,
      params,
      "LIST_PRINT_DATA"
    );
  }

  async getPrintSettings() {
    const rows = await this._query(
      `SELECT settings, updated_at FROM \`${PRINT_SETTINGS_TABLE}\` WHERE id = 1`,
      [],
      "GET_PRINT_SETTINGS"
    );
    return rows && rows[0] ? rows[0] : null;
  }

  savePrintSettings(settings, updated_by) {
    // Pinned to id = 1: this is one shared look for the whole chain, not a
    // row per save.
    return this._query(
      `INSERT INTO \`${PRINT_SETTINGS_TABLE}\` (id, settings, updated_by)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE settings = VALUES(settings), updated_by = VALUES(updated_by)`,
      [JSON.stringify(settings), updated_by ?? null],
      "SAVE_PRINT_SETTINGS"
    );
  }

  setTalkerText(group_id, talker_text) {
    return this._query(
      `UPDATE \`${GROUPS_TABLE}\` SET talker_text = ? WHERE id = ?`,
      [talker_text, group_id],
      "SET_TALKER_TEXT",
      { group_id }
    );
  }

  /**
   * The MRP and price a card should carry, per article, for one outlet.
   *
   * Batch data holds a row per outlet per batch, so an article can have several
   * MRPs at one store. The newest batch that still has stock is the one a
   * customer will actually pick up, so that is what the shelf card must quote -
   * a sold-out batch would print a price nobody can buy at.
   *
   * Falls back to the newest batch outright when nothing is in stock, so a card
   * still prints; the caller flags those rather than showing a blank.
   */
  listPrintPrices(outlet_id, item_codes) {
    if (!item_codes || !item_codes.length) return Promise.resolve([]);
    // MySQL 5.7 has no window functions, so "newest with stock" is encoded as a
    // sortable string and picked with MAX().
    return this._query(
      `SELECT item_code,
              MAX(CONCAT(
                IF(COALESCE(stock_qty, 0) > 0, '1', '0'),
                DATE_FORMAT(COALESCE(price_uploaded_at, '1970-01-01'), '%Y%m%d%H%i%s'),
                LPAD(CAST(ROUND(COALESCE(mrp, 0) * 100) AS CHAR), 12, '0'),
                LPAD(CAST(ROUND(COALESCE(selling_price, 0) * 100) AS CHAR), 12, '0')
              )) AS pick
       FROM \`offers_v3_batch_data\`
       WHERE outlet_id = ? AND item_code IN (?)
       GROUP BY item_code`,
      [outlet_id, item_codes],
      "LIST_PRINT_PRICES",
      { outlet_id }
    ).then((rows) =>
      rows.map((r) => {
        // in_stock(1) + uploaded_at(14) + mrp paise(12) + price paise(12).
        // Paise rather than a formatted decimal: FORMAT() inserts thousands
        // separators, which would shift every field after it.
        const pick = String(r.pick || "");
        const paise = (from) => Number(pick.slice(from, from + 12)) / 100;
        return {
          item_code: r.item_code,
          in_stock: pick.slice(0, 1) === "1",
          mrp: paise(15) || null,
          price: paise(27) || null,
        };
      })
    );
  }

  // ---------------------------------------------------------------------
  // Locations
  // ---------------------------------------------------------------------

  listLocations({ group_id, outlet_id, active } = {}) {
    const where = [];
    const params = [];
    if (group_id) {
      where.push("l.group_id = ?");
      params.push(group_id);
    }
    if (outlet_id) {
      where.push("l.outlet_id = ?");
      params.push(outlet_id);
    }
    if (active !== undefined) {
      where.push("l.active = ?");
      params.push(active ? 1 : 0);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this._query(
      `SELECT l.*, o.outlet_name, g.label AS group_label
       FROM \`${LOCATIONS_TABLE}\` l
       LEFT JOIN outlets o ON o.outlet_id = l.outlet_id
       LEFT JOIN \`${GROUPS_TABLE}\` g ON g.id = l.group_id
       ${whereSql}
       ORDER BY g.label ASC, l.label ASC`,
      params,
      "LIST_LOCATIONS"
    );
  }

  async getLocationById(id) {
    const rows = await this._query(
      `SELECT l.*, o.outlet_name, g.label AS group_label, g.talker_text,
              g.expected_price, g.expected_pct_off, g.status AS group_status
       FROM \`${LOCATIONS_TABLE}\` l
       LEFT JOIN outlets o ON o.outlet_id = l.outlet_id
       LEFT JOIN \`${GROUPS_TABLE}\` g ON g.id = l.group_id
       WHERE l.id = ?`,
      [id],
      "GET_LOCATION",
      { id }
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async createLocation({
    group_id,
    outlet_id,
    label,
    location_type = "other",
    pending_tier = 1,
  }) {
    const res = await this._query(
      `INSERT INTO \`${LOCATIONS_TABLE}\` (group_id, outlet_id, label, location_type, pending_tier, pending_since)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [group_id, outlet_id, label, location_type, pending_tier],
      "CREATE_LOCATION",
      { group_id, outlet_id }
    );
    return res.insertId;
  }

  async setLocationActive(id, active) {
    const res = await this._query(
      `UPDATE \`${LOCATIONS_TABLE}\`
       SET active = ?, last_seen = NOW(),
           pending_tier = CASE WHEN ? = 0 THEN NULL ELSE pending_tier END
       WHERE id = ?`,
      [active ? 1 : 0, active ? 1 : 0, id],
      "SET_LOCATION_ACTIVE",
      { id }
    );
    return { affectedRows: res.affectedRows };
  }

  /** Membership change on a published group re-flags its locations to tier 1. */
  async flagGroupLocationsTier1(group_id) {
    const res = await this._query(
      `UPDATE \`${LOCATIONS_TABLE}\`
       SET pending_tier = 1, pending_since = COALESCE(pending_since, NOW())
       WHERE group_id = ? AND active = 1`,
      [group_id],
      "FLAG_TIER1",
      { group_id }
    );
    return { affectedRows: res.affectedRows };
  }

  /** Tier 3: HQ pushes one group to the top of an outlet's queue. */
  async pushGroupToOutletQueue(group_id, outlet_id) {
    const params = [group_id];
    let outletSql = "";
    if (outlet_id) {
      outletSql = " AND outlet_id = ?";
      params.push(outlet_id);
    }
    const res = await this._query(
      `UPDATE \`${LOCATIONS_TABLE}\`
       SET pending_tier = 3, pending_since = COALESCE(pending_since, NOW())
       WHERE group_id = ? AND active = 1${outletSql}`,
      params,
      "PUSH_TIER3",
      { group_id, outlet_id }
    );
    return { affectedRows: res.affectedRows };
  }

  setLocationQueueState(id, { pending_tier, pending_since, last_accepted_at }) {
    const sets = [];
    const params = [];
    if (pending_tier !== undefined) {
      sets.push("pending_tier = ?");
      params.push(pending_tier);
    }
    if (pending_since !== undefined) {
      sets.push("pending_since = ?");
      params.push(pending_since);
    }
    if (last_accepted_at !== undefined) {
      sets.push("last_accepted_at = ?");
      params.push(last_accepted_at);
    }
    if (!sets.length) {
      return Promise.resolve({ affectedRows: 0 });
    }
    params.push(id);
    return this._query(
      `UPDATE \`${LOCATIONS_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
      params,
      "SET_LOCATION_QUEUE_STATE",
      { id }
    );
  }

  /**
   * The outlet's queue for a round: every active location of a published group,
   * with its pending tier, how long it has been owed, and whether a proof
   * already landed this round.
   */
  listQueueForOutlet(outlet_id, round_date) {
    return this._query(
      `SELECT l.id AS location_id, l.label AS location_label, l.pending_tier,
              l.pending_since, l.last_accepted_at,
              g.id AS group_id, g.label AS group_label, g.talker_text,
              g.expected_price, g.expected_pct_off,
              (SELECT COUNT(*) FROM \`${LOCATIONS_TABLE}\` sib
                 WHERE sib.group_id = g.id AND sib.outlet_id = l.outlet_id AND sib.active = 1) AS group_location_count,
              (SELECT COUNT(*) FROM \`${GROUP_ITEMS_TABLE}\` gi WHERE gi.group_id = g.id) AS item_count,
              p.id AS proof_id, p.ai_verdict, p.status AS proof_status,
              DATEDIFF(?, DATE(l.pending_since)) AS pending_age_days
       FROM \`${LOCATIONS_TABLE}\` l
       INNER JOIN \`${GROUPS_TABLE}\` g ON g.id = l.group_id
       LEFT JOIN \`${PROOFS_TABLE}\` p ON p.location_id = l.id AND p.round_date = ?
       WHERE l.outlet_id = ? AND l.active = 1 AND g.status = 'published'
       ORDER BY l.pending_tier ASC, l.pending_since ASC, g.label ASC`,
      [round_date, round_date, outlet_id],
      "LIST_QUEUE",
      { outlet_id, round_date }
    );
  }

  /**
   * Published groups with no location yet at this outlet - the discovery rows.
   * Staff photograph each place the brand sits, creating locations as they go.
   */
  listUndiscoveredGroupsForOutlet(outlet_id) {
    return this._query(
      `SELECT g.id AS group_id, g.label AS group_label, g.talker_text,
              g.expected_price, g.expected_pct_off,
              (SELECT COUNT(*) FROM \`${GROUP_ITEMS_TABLE}\` gi WHERE gi.group_id = g.id) AS item_count
       FROM \`${GROUPS_TABLE}\` g
       LEFT JOIN \`${LOCATIONS_TABLE}\` l ON l.group_id = g.id AND l.outlet_id = ? AND l.active = 1
       WHERE g.status = 'published' AND l.id IS NULL
       ORDER BY g.label ASC`,
      [outlet_id],
      "LIST_UNDISCOVERED",
      { outlet_id }
    );
  }

  // ---------------------------------------------------------------------
  // Proofs
  // ---------------------------------------------------------------------

  /** One proof per location per round; a retake reuses the same row. */
  async upsertProof({ location_id, round_date, tier, uploaded_by, note }) {
    await this._query(
      `INSERT INTO \`${PROOFS_TABLE}\` (location_id, round_date, tier, uploaded_by, note)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tier = VALUES(tier),
         uploaded_by = VALUES(uploaded_by),
         uploaded_at = NOW(),
         note = VALUES(note),
         ai_verdict = NULL,
         ai_response_json = NULL,
         ai_model = NULL,
         status = 'submitted',
         reviewed_by = NULL,
         reviewed_at = NULL,
         review_note = NULL`,
      [location_id, round_date, tier ?? 2, uploaded_by ?? null, note ?? null],
      "UPSERT_PROOF",
      { location_id, round_date }
    );
    const rows = await this._query(
      `SELECT * FROM \`${PROOFS_TABLE}\` WHERE location_id = ? AND round_date = ?`,
      [location_id, round_date],
      "GET_PROOF_AFTER_UPSERT",
      { location_id, round_date }
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async addProofImage(proof_id, s3_url) {
    const res = await this._query(
      `INSERT INTO \`${PROOF_IMAGES_TABLE}\` (proof_id, s3_url) VALUES (?, ?)`,
      [proof_id, s3_url],
      "ADD_PROOF_IMAGE",
      { proof_id }
    );
    return res.insertId;
  }

  setProofAiResult(proof_id, { ai_verdict, ai_response_json, ai_model, status }) {
    return this._query(
      `UPDATE \`${PROOFS_TABLE}\`
       SET ai_verdict = ?, ai_response_json = ?, ai_model = ?, status = ?
       WHERE id = ?`,
      [ai_verdict, ai_response_json, ai_model, status, proof_id],
      "SET_PROOF_AI",
      { proof_id }
    );
  }

  async getProofById(id) {
    const rows = await this._query(
      `SELECT p.*, l.label AS location_label, l.outlet_id, l.group_id,
              o.outlet_name, g.label AS group_label, g.talker_text
       FROM \`${PROOFS_TABLE}\` p
       LEFT JOIN \`${LOCATIONS_TABLE}\` l ON l.id = p.location_id
       LEFT JOIN outlets o ON o.outlet_id = l.outlet_id
       LEFT JOIN \`${GROUPS_TABLE}\` g ON g.id = l.group_id
       WHERE p.id = ?`,
      [id],
      "GET_PROOF",
      { id }
    );
    return rows && rows[0] ? rows[0] : null;
  }

  listProofImages(proof_ids) {
    if (!proof_ids || !proof_ids.length) {
      return Promise.resolve([]);
    }
    const placeholders = proof_ids.map(() => "?").join(", ");
    return this._query(
      `SELECT id, proof_id, s3_url, uploaded_at
       FROM \`${PROOF_IMAGES_TABLE}\`
       WHERE proof_id IN (${placeholders})
       ORDER BY uploaded_at ASC`,
      proof_ids,
      "LIST_PROOF_IMAGES"
    );
  }

  listProofs({ round_date, outlet_id, ai_verdict, status, exceptions_only } = {}) {
    const where = [];
    const params = [];
    if (round_date) {
      where.push("p.round_date = ?");
      params.push(round_date);
    }
    if (outlet_id) {
      where.push("l.outlet_id = ?");
      params.push(outlet_id);
    }
    if (ai_verdict) {
      where.push("p.ai_verdict = ?");
      params.push(ai_verdict);
    }
    if (status) {
      where.push("p.status = ?");
      params.push(status);
    }
    // The board is exception-based: only rejects that nobody has closed out.
    if (exceptions_only) {
      where.push("p.ai_verdict = 'reject' AND p.status <> 'overridden'");
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this._query(
      `SELECT p.*, l.label AS location_label, l.outlet_id, l.group_id,
              o.outlet_name, g.label AS group_label, g.talker_text,
              COALESCE(ne.employee_name, '') AS uploaded_by_name
       FROM \`${PROOFS_TABLE}\` p
       LEFT JOIN \`${LOCATIONS_TABLE}\` l ON l.id = p.location_id
       LEFT JOIN outlets o ON o.outlet_id = l.outlet_id
       LEFT JOIN \`${GROUPS_TABLE}\` g ON g.id = l.group_id
       LEFT JOIN new_employee ne ON ne.employee_id = p.uploaded_by
       ${whereSql}
       ORDER BY p.uploaded_at DESC`,
      params,
      "LIST_PROOFS"
    );
  }

  reviewProof(id, { status, reviewed_by, review_note }) {
    return this._query(
      `UPDATE \`${PROOFS_TABLE}\`
       SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ?
       WHERE id = ?`,
      [status, reviewed_by ?? null, review_note ?? null, id],
      "REVIEW_PROOF",
      { id }
    );
  }

  /**
   * Share of an outlet's recent checked photos that came back clean. Drives
   * how hard that outlet gets sampled. Returns null when there is not enough
   * history to judge.
   */
  async getOutletAcceptRate(outlet_id, days = 30) {
    const rows = await this._query(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN p.ai_verdict = 'accept' THEN 1 ELSE 0 END) AS accepted
       FROM \`${PROOFS_TABLE}\` p
       INNER JOIN \`${LOCATIONS_TABLE}\` l ON l.id = p.location_id
       WHERE l.outlet_id = ?
         AND p.ai_verdict IS NOT NULL
         AND p.round_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [outlet_id, days],
      "GET_ACCEPT_RATE",
      { outlet_id }
    );
    const row = rows && rows[0] ? rows[0] : null;
    const checked = Number(row?.checked ?? 0);
    if (checked < 10) {
      return null;
    }
    return Number(row.accepted ?? 0) / checked;
  }

  /** Per-outlet counts for the HQ board on a given round. */
  listBoardCounts(round_date) {
    return this._query(
      `SELECT l.outlet_id, o.outlet_name,
              COUNT(DISTINCT CASE WHEN l.active = 1 AND g.status = 'published' THEN l.id END) AS total_locations,
              COUNT(DISTINCT CASE WHEN p.round_date = ? THEN p.id END) AS shot_today,
              COUNT(DISTINCT CASE WHEN p.round_date = ? AND p.ai_verdict = 'accept' THEN p.id END) AS accepted,
              COUNT(DISTINCT CASE WHEN p.round_date = ? AND p.ai_verdict = 'retake' THEN p.id END) AS retakes,
              COUNT(DISTINCT CASE WHEN p.round_date = ? AND p.ai_verdict = 'reject' AND p.status <> 'overridden' THEN p.id END) AS open_rejects,
              COUNT(DISTINCT CASE WHEN l.active = 1 AND g.status = 'published' AND l.pending_tier IS NOT NULL THEN l.id END) AS pending_locations
       FROM \`${LOCATIONS_TABLE}\` l
       INNER JOIN \`${GROUPS_TABLE}\` g ON g.id = l.group_id
       LEFT JOIN outlets o ON o.outlet_id = l.outlet_id
       LEFT JOIN \`${PROOFS_TABLE}\` p ON p.location_id = l.id
       GROUP BY l.outlet_id, o.outlet_name
       ORDER BY o.outlet_name ASC`,
      [round_date, round_date, round_date, round_date],
      "LIST_BOARD_COUNTS",
      { round_date }
    );
  }

  // ---------------------------------------------------------------------
  // Edit log
  // ---------------------------------------------------------------------

  logGroupEdit({ group_id, changed_by, change_type, detail }) {
    return this._query(
      `INSERT INTO \`${EDIT_LOG_TABLE}\` (group_id, changed_by, change_type, detail_json)
       VALUES (?, ?, ?, ?)`,
      [
        group_id,
        changed_by ?? null,
        change_type,
        detail ? JSON.stringify(detail) : null,
      ],
      "LOG_GROUP_EDIT",
      { group_id, change_type }
    );
  }

  listGroupEditLog(group_id) {
    return this._query(
      `SELECT el.*, COALESCE(ne.employee_name, '') AS changed_by_name
       FROM \`${EDIT_LOG_TABLE}\` el
       LEFT JOIN new_employee ne ON ne.employee_id = el.changed_by
       WHERE el.group_id = ?
       ORDER BY el.changed_at DESC`,
      [group_id],
      "LIST_EDIT_LOG",
      { group_id }
    );
  }
}

module.exports = (db) => {
  return new OffersV3TalkerRepository(db);
};
