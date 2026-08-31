const logger = require("../utils/logger");
const { checkTalkerPhoto } = require("../services/talker_check");

/** Standing talkers are re-shot on roughly this cycle. */
const ROTATION_DAYS = 10;

/**
 * Smallest cluster worth a *brand* group. A supplier with one article on offer
 * isn't a brand block, so it doesn't get a "Supplier - 22% off" sign; it falls
 * through and gets an individual sign named after the product instead. Either
 * way it is created for you - making one by hand per article doesn't scale.
 */
const MIN_BRAND_GROUP_ARTICLES = 2;

/**
 * How many not-yet-mapped groups an outlet is asked to find in one day.
 *
 * Without this, day one of a full rollout shows every store a list of all
 * 300-400 published groups at once, every one of them pinned as mandatory.
 * Nobody works that list. Capping it lets the location map build a bit at a
 * time on its own, instead of depending on someone remembering to phase the
 * rollout by hand.
 */
const DISCOVERY_PER_DAY = 15;
/** Outlets whose photos keep failing get sampled harder. */
const POOR_HIT_RATE = 0.8;
const POOR_HIT_RATE_ROTATION_DAYS = 5;

const TIER_FLAGGED = 1;
const TIER_ROTATION = 2;
const TIER_ON_DEMAND = 3;

function logError(code, description, ref = {}) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "USECASE.OFFERS_V3_TALKER",
    code,
    description,
    category: "",
    ref,
  });
}

/**
 * Outlet names are stored with a chain prefix (and occasional stray
 * whitespace); staff and HQ only ever see the short name.
 */
function displayOutletName(outlet_name) {
  return String(outlet_name ?? "")
    .replace(/^\s*daily\s*needs\s*[-–]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function todayIso() {
  const d = new Date();
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Auto-grouping key. Articles sharing a supplier and the same markdown rule are
 * one brand sign; anything that doesn't cluster (special price, flat rupee-off)
 * stands alone as an individual group.
 *
 * NOTE: this is the one place the clustering rule lives - the mpfd_* value
 * vocabulary comes from the Gofrugal markup/markdown master, so tune only here
 * once it has been run against production data.
 */
function groupingKey(row) {
  const supplier = String(row.supplier ?? "").trim();
  const isPercentage = /perc|%/i.test(String(row.mpfd_amt_perc ?? ""));
  const markdownValue = String(row.mpfd_value ?? "").trim();

  if (!supplier || !markdownValue || !isPercentage) {
    return null; // individual
  }
  return `${supplier.toLowerCase()}|${markdownValue}`;
}

class OffersV3TalkerUsecase {
  constructor(talkerRepo, outletRepo) {
    this.talkerRepo = talkerRepo;
    this.outletRepo = outletRepo;
  }

  // ---------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------

  async listGroups(filters) {
    return this.talkerRepo.listGroups(filters);
  }

  async getGroup(id) {
    const group = await this.talkerRepo.getGroupById(id);
    if (!group) {
      return null;
    }
    const [items, locations, suggested, editLog] = await Promise.all([
      this.talkerRepo.listGroupItems(id),
      this.talkerRepo.listLocations({ group_id: id }),
      this.talkerRepo.listSuggestedItems(id),
      this.talkerRepo.listGroupEditLog(id),
    ]);
    return {
      ...group,
      items,
      locations: locations.map((l) => ({
        ...l,
        outlet_name: displayOutletName(l.outlet_name),
      })),
      suggested,
      edit_log: editLog,
    };
  }

  async createGroup(data, created_by) {
    const id = await this.talkerRepo.createGroup({
      ...data,
      origin: "manual",
      status: "draft",
      created_by,
    });
    if (data.item_codes && data.item_codes.length) {
      await this.talkerRepo.addItemsToGroup(id, data.item_codes);
    }
    await this.talkerRepo.logGroupEdit({
      group_id: id,
      changed_by: created_by,
      change_type: "create",
      detail: { label: data.label, item_count: data.item_codes?.length ?? 0 },
    });
    return { code: 200, id };
  }

  /**
   * Editing a published group:
   *  - membership change  -> re-flag its locations to tier 1 for one re-shoot
   *  - label / talker text -> deliberately NO re-flag; a typo fix must not cost
   *    five re-shoots
   */
  async updateGroup(id, fields, changed_by) {
    const group = await this.talkerRepo.getGroupById(id);
    if (!group) {
      return { code: 404, msg: "Group not found" };
    }
    if (group.status === "ended") {
      return { code: 400, msg: "Ended groups are frozen and cannot be edited" };
    }

    await this.talkerRepo.updateGroup(id, fields);

    const changedKeys = Object.keys(fields);
    if (changedKeys.length) {
      await this.talkerRepo.logGroupEdit({
        group_id: id,
        changed_by,
        change_type: changedKeys.includes("talker_text")
          ? "talker_text"
          : "label",
        detail: { fields: changedKeys },
      });
    }
    return { code: 200 };
  }

  async setGroupItems(id, { add = [], remove = [] }, changed_by) {
    const group = await this.talkerRepo.getGroupById(id);
    if (!group) {
      return { code: 404, msg: "Group not found" };
    }
    if (group.status === "ended") {
      return {
        code: 400,
        msg: "Ended groups are frozen - membership cannot change",
      };
    }

    if (add.length) {
      await this.talkerRepo.addItemsToGroup(id, add);
    }
    if (remove.length) {
      await this.talkerRepo.removeItemsFromGroup(id, remove);
    }

    if (add.length || remove.length) {
      await this.talkerRepo.logGroupEdit({
        group_id: id,
        changed_by,
        change_type: add.length ? "items_added" : "items_removed",
        detail: { added: add, removed: remove },
      });
      // Membership changed: this sign now says something different, so it gets
      // re-shot once.
      if (group.status === "published") {
        await this.talkerRepo.flagGroupLocationsTier1(id);
      }
    }
    return { code: 200 };
  }

  async publishGroup(id, changed_by) {
    const group = await this.talkerRepo.getGroupById(id);
    if (!group) {
      return { code: 404, msg: "Group not found" };
    }
    const items = await this.talkerRepo.listGroupItems(id);
    if (!items.length) {
      return { code: 400, msg: "Cannot publish a group with no articles" };
    }
    await this.talkerRepo.updateGroup(id, { status: "published" });
    await this.talkerRepo.logGroupEdit({
      group_id: id,
      changed_by,
      change_type: "publish",
      detail: { item_count: items.length },
    });
    return { code: 200 };
  }

  async endGroup(id, changed_by) {
    const group = await this.talkerRepo.getGroupById(id);
    if (!group) {
      return { code: 404, msg: "Group not found" };
    }
    await this.talkerRepo.updateGroup(id, { status: "ended" });
    // An ended offer's sign must come down - stop asking for photos of it.
    const locations = await this.talkerRepo.listLocations({ group_id: id });
    for (const loc of locations) {
      await this.talkerRepo.setLocationQueueState(loc.id, {
        pending_tier: null,
      });
    }
    await this.talkerRepo.logGroupEdit({
      group_id: id,
      changed_by,
      change_type: "end",
      detail: {},
    });
    return { code: 200 };
  }

  async deleteGroup(id) {
    const res = await this.talkerRepo.deleteGroup(id);
    if (!res.affectedRows) {
      return { code: 400, msg: "Only draft groups can be deleted" };
    }
    return { code: 200 };
  }

  async mergeGroups(from_group_id, to_group_id, changed_by) {
    const [from, to] = await Promise.all([
      this.talkerRepo.getGroupById(from_group_id),
      this.talkerRepo.getGroupById(to_group_id),
    ]);
    if (!from || !to) {
      return { code: 404, msg: "Group not found" };
    }
    if (from.status === "ended" || to.status === "ended") {
      return { code: 400, msg: "Ended groups are frozen" };
    }
    await this.talkerRepo.mergeGroups(from_group_id, to_group_id);
    await this.talkerRepo.logGroupEdit({
      group_id: to_group_id,
      changed_by,
      change_type: "merge",
      detail: { merged_from: from.label },
    });
    if (to.status === "published") {
      await this.talkerRepo.flagGroupLocationsTier1(to_group_id);
    }
    return { code: 200 };
  }

  /** Split: move a subset of articles out into a new group. */
  async splitGroup(id, { item_codes, label }, changed_by) {
    const group = await this.talkerRepo.getGroupById(id);
    if (!group) {
      return { code: 404, msg: "Group not found" };
    }
    if (group.status === "ended") {
      return { code: 400, msg: "Ended groups are frozen" };
    }
    if (!item_codes || !item_codes.length) {
      return { code: 400, msg: "Pick at least one article to split out" };
    }

    const newId = await this.talkerRepo.createGroup({
      label: label || `${group.label} (split)`,
      group_type: group.group_type,
      origin: "manual",
      status: group.status === "published" ? "draft" : group.status,
      supplier: group.supplier,
      markdown_pct: group.markdown_pct,
      talker_text: group.talker_text,
      expected_price: group.expected_price,
      expected_pct_off: group.expected_pct_off,
      created_by: changed_by,
    });
    // The unique key on item_code moves them; no explicit remove needed.
    await this.talkerRepo.addItemsToGroup(newId, item_codes);

    await this.talkerRepo.logGroupEdit({
      group_id: id,
      changed_by,
      change_type: "split",
      detail: { split_to: newId, item_codes },
    });
    if (group.status === "published") {
      await this.talkerRepo.flagGroupLocationsTier1(id);
    }
    return { code: 200, id: newId };
  }

  // ---------------------------------------------------------------------
  // Auto-derivation
  // ---------------------------------------------------------------------

  /**
   * Cluster active offer articles into draft groups by supplier + markdown.
   * Articles already in a group are left alone - once published, auto-grouping
   * stops touching membership, and anything new lands in that group's suggested
   * tray instead of being added silently.
   */
  async autoDeriveGroups(created_by) {
    const rows = await this.talkerRepo.listOfferArticlesForGrouping();
    const existingGroups = await this.talkerRepo.listGroups({});
    const existingByKey = new Map();
    for (const g of existingGroups) {
      if (g.supplier && g.markdown_pct !== null) {
        existingByKey.set(
          `${String(g.supplier).toLowerCase()}|${g.markdown_pct}`,
          g
        );
      }
    }

    const grouped = new Map();
    const individuals = [];
    for (const row of rows) {
      const key = groupingKey(row);
      if (!key) {
        individuals.push(row);
        continue;
      }
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(row);
    }

    let createdBrandGroups = 0;
    let createdIndividualGroups = 0;
    let suggested = 0;
    const suggestions = [];

    for (const [key, members] of grouped.entries()) {
      // A supplier with one article on offer is not a brand block - it drops
      // down to an individual sign below rather than becoming a brand group.
      if (members.length < MIN_BRAND_GROUP_ARTICLES) {
        individuals.push(...members);
        continue;
      }
      const existing = existingByKey.get(key);
      if (existing) {
        // Never add silently to an existing group.
        for (const m of members) {
          suggestions.push({ group_id: existing.id, item_code: m.item_code });
        }
        continue;
      }
      const first = members[0];
      const id = await this.talkerRepo.createGroup({
        label: `${first.supplier} — ${first.mpfd_value}% off`,
        group_type: "brand",
        origin: "auto",
        status: "draft",
        supplier: first.supplier,
        markdown_pct: Number(first.mpfd_value) || null,
        expected_pct_off: Number(first.mpfd_value) || null,
        created_by,
      });
      await this.talkerRepo.addItemsToGroup(
        id,
        members.map((m) => m.item_code)
      );
      await this.talkerRepo.logGroupEdit({
        group_id: id,
        changed_by: created_by,
        change_type: "create",
        detail: { origin: "auto", item_count: members.length },
      });
      createdBrandGroups += 1;
    }

    // Everything that didn't join a brand block - a lone supplier, a flat
    // rupee-off, a special price - gets its own sign named after the product.
    // These are created rather than left for someone to make by hand: there
    // can be hundreds, and one sign per article is the normal case for them.
    for (const row of individuals) {
      const id = await this.talkerRepo.createGroup({
        label: row.item_name || `Item ${row.item_code}`,
        group_type: "individual",
        origin: "auto",
        status: "draft",
        supplier: row.supplier ?? null,
        created_by,
      });
      await this.talkerRepo.addItemsToGroup(id, [row.item_code]);
      createdIndividualGroups += 1;
    }

    if (suggestions.length) {
      const res = await this.talkerRepo.addSuggestedItems(suggestions);
      suggested = res.added;
    }

    return {
      code: 200,
      createdGroups: createdBrandGroups + createdIndividualGroups,
      createdBrandGroups,
      createdIndividualGroups,
      suggested,
    };
  }

  listUngrouped() {
    return this.talkerRepo.listUngroupedArticles();
  }

  /** The pool a group's articles can be picked from: things actually on offer. */
  listOfferArticles() {
    return this.talkerRepo.listOfferArticles();
  }

  async resolveSuggestedItem(id, accept, resolved_by) {
    const row = await this.talkerRepo.resolveSuggestedItem(
      id,
      accept ? "accepted" : "rejected",
      resolved_by
    );
    if (!row) {
      return { code: 404, msg: "Suggestion not found" };
    }
    if (accept) {
      await this.talkerRepo.addItemsToGroup(row.group_id, [row.item_code]);
      await this.talkerRepo.logGroupEdit({
        group_id: row.group_id,
        changed_by: resolved_by,
        change_type: "items_added",
        detail: { added: [row.item_code], via: "suggestion" },
      });
      const group = await this.talkerRepo.getGroupById(row.group_id);
      if (group && group.status === "published") {
        await this.talkerRepo.flagGroupLocationsTier1(row.group_id);
      }
    }
    return { code: 200 };
  }

  // ---------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------

  /**
   * The outlet's queue for today, tier-sorted.
   *
   *  tier 1 - pinned, mandatory: a talker whose state changed
   *  tier 2 - rotation: standing talkers on a ~10-day cycle
   *  tier 3 - on demand: HQ pushed this one after a complaint
   *
   * Rollover is inherent: an unphotographed flagged location keeps its
   * pending_tier and its pending_since, so it stays on tomorrow's list and ages
   * rather than vanishing.
   */
  async getQueueForOutlet(outlet_id, round_date) {
    const day = round_date || todayIso();
    const [rows, undiscovered, acceptRate] = await Promise.all([
      this.talkerRepo.listQueueForOutlet(outlet_id, day),
      this.talkerRepo.listUndiscoveredGroupsForOutlet(outlet_id),
      this.talkerRepo.getOutletAcceptRate(outlet_id, 30),
    ]);

    const rotationDays =
      acceptRate !== null && acceptRate < POOR_HIT_RATE
        ? POOR_HIT_RATE_ROTATION_DAYS
        : ROTATION_DAYS;

    const queue = [];
    for (const row of rows) {
      // Already shot and accepted this round - nothing owed.
      if (row.proof_id && row.ai_verdict === "accept") {
        continue;
      }

      let tier = row.pending_tier;
      if (!tier) {
        // Not flagged: due only if its rotation slot has come round.
        const lastAccepted = row.last_accepted_at
          ? String(row.last_accepted_at).slice(0, 10)
          : null;
        const age = lastAccepted ? daysBetween(lastAccepted, day) : null;
        if (age !== null && age < rotationDays) {
          continue;
        }
        tier = TIER_ROTATION;
      }

      queue.push({
        location_id: row.location_id,
        location_label: row.location_label,
        group_id: row.group_id,
        group_label: row.group_label,
        talker_text: row.talker_text,
        expected_price: row.expected_price,
        expected_pct_off: row.expected_pct_off,
        item_count: row.item_count,
        group_location_count: row.group_location_count,
        tier,
        pending_age_days: row.pending_age_days ?? 0,
        already_shot: Boolean(row.proof_id),
        last_verdict: row.ai_verdict ?? null,
        discovery: false,
      });
    }

    // Discovery rows: the first time a group reaches this outlet, staff
    // photograph each place the brand sits, creating locations as they go.
    // Only a day's worth is offered - the rest wait their turn, so a full
    // rollout doesn't open with an unworkable list.
    for (const g of undiscovered.slice(0, DISCOVERY_PER_DAY)) {
      queue.push({
        location_id: null,
        location_label: null,
        group_id: g.group_id,
        group_label: g.group_label,
        talker_text: g.talker_text,
        expected_price: g.expected_price,
        expected_pct_off: g.expected_pct_off,
        item_count: g.item_count,
        group_location_count: 0,
        tier: TIER_FLAGGED,
        pending_age_days: 0,
        already_shot: false,
        last_verdict: null,
        discovery: true,
      });
    }

    queue.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return (b.pending_age_days ?? 0) - (a.pending_age_days ?? 0);
    });

    return {
      code: 200,
      round_date: day,
      rotation_days: rotationDays,
      accept_rate: acceptRate,
      // What's left to map, so staff can see the job is finite and HQ can see
      // how far the rollout has got.
      discovery_remaining: Math.max(0, undiscovered.length - DISCOVERY_PER_DAY),
      discovery_total: undiscovered.length,
      data: queue,
    };
  }

  async addLocation({ group_id, outlet_id, label }, created_by) {
    const group = await this.talkerRepo.getGroupById(group_id);
    if (!group) {
      return { code: 404, msg: "Group not found" };
    }
    const id = await this.talkerRepo.createLocation({
      group_id,
      outlet_id,
      label,
    });
    await this.talkerRepo.logGroupEdit({
      group_id,
      changed_by: created_by,
      change_type: "location_added",
      detail: { outlet_id, label },
    });
    return { code: 200, id };
  }

  async setLocationActive(id, active, changed_by) {
    const location = await this.talkerRepo.getLocationById(id);
    if (!location) {
      return { code: 404, msg: "Location not found" };
    }
    await this.talkerRepo.setLocationActive(id, active);
    await this.talkerRepo.logGroupEdit({
      group_id: location.group_id,
      changed_by,
      change_type: active ? "location_added" : "location_removed",
      detail: { location_id: id, label: location.label },
    });
    return { code: 200 };
  }

  /** Tier 3: HQ pushes a group to the top of an outlet's queue. */
  async pushToQueue(group_id, outlet_id) {
    const res = await this.talkerRepo.pushGroupToOutletQueue(
      group_id,
      outlet_id
    );
    return { code: 200, affectedRows: res.affectedRows };
  }

  // ---------------------------------------------------------------------
  // Proofs
  // ---------------------------------------------------------------------

  /**
   * Staff submit one photo for one location. The AI check runs inline so the
   * verdict comes back while they are still in the aisle.
   */
  async submitProof({ location_id, s3_url, note, tier }, uploaded_by) {
    const location = await this.talkerRepo.getLocationById(location_id);
    if (!location) {
      return { code: 404, msg: "Location not found" };
    }

    const round_date = todayIso();
    const proof = await this.talkerRepo.upsertProof({
      location_id,
      round_date,
      tier: tier ?? location.pending_tier ?? TIER_ROTATION,
      uploaded_by,
      note,
    });
    await this.talkerRepo.addProofImage(proof.id, s3_url);

    const items = await this.talkerRepo.listGroupItems(location.group_id);
    const check = await checkTalkerPhoto({
      imageUrl: s3_url,
      group_label: location.group_label,
      talker_text: location.talker_text,
      expected_price: location.expected_price,
      expected_pct_off: location.expected_pct_off,
      item_names: items.map((i) => i.item_name).filter(Boolean),
    });

    await this.talkerRepo.setProofAiResult(proof.id, {
      ai_verdict: check.verdict,
      ai_response_json: JSON.stringify(check.observation ?? {}),
      ai_model: check.model,
      // `submitted` is terminal - review is exception-based, so only a reject
      // needs a human to look at it.
      status: check.verdict === "reject" ? "rejected" : "submitted",
    });

    // Feedback into the queue: a clean accept goes back of rotation, anything
    // else jumps to tomorrow.
    if (check.verdict === "accept") {
      await this.talkerRepo.setLocationQueueState(location_id, {
        pending_tier: null,
        pending_since: null,
        last_accepted_at: new Date(),
      });
    } else {
      await this.talkerRepo.setLocationQueueState(location_id, {
        pending_tier: TIER_FLAGGED,
        pending_since: new Date(),
      });
    }

    return {
      code: 200,
      proof_id: proof.id,
      verdict: check.verdict,
      reason: check.reason,
      ai_model: check.model,
    };
  }

  /**
   * Discovery: staff found a new spot for this group and photographed it in one
   * step - create the location, then treat it as a normal submission.
   */
  async submitDiscoveryProof(
    { group_id, outlet_id, label, s3_url, note },
    uploaded_by
  ) {
    const created = await this.addLocation(
      { group_id, outlet_id, label },
      uploaded_by
    );
    if (created.code !== 200) {
      return created;
    }
    return this.submitProof(
      { location_id: created.id, s3_url, note, tier: TIER_FLAGGED },
      uploaded_by
    );
  }

  async listProofs(filters) {
    const proofs = await this.talkerRepo.listProofs(filters);
    if (!proofs.length) {
      return [];
    }
    const images = await this.talkerRepo.listProofImages(
      proofs.map((p) => p.id)
    );
    const byProof = new Map();
    for (const img of images) {
      if (!byProof.has(img.proof_id)) {
        byProof.set(img.proof_id, []);
      }
      byProof.get(img.proof_id).push(img);
    }
    return proofs.map((p) => ({
      ...p,
      outlet_name: displayOutletName(p.outlet_name),
      ai_response: p.ai_response_json ? safeParse(p.ai_response_json) : null,
      images: byProof.get(p.id) ?? [],
    }));
  }

  /**
   * The HQ board: per-outlet counts plus the open exception list. Review is
   * exception-based - `submitted` is terminal, HQ only ever touches rejects.
   */
  async getBoard(round_date) {
    const day = round_date || todayIso();
    const [counts, exceptions] = await Promise.all([
      this.talkerRepo.listBoardCounts(day),
      this.listProofs({ exceptions_only: true }),
    ]);
    return {
      code: 200,
      round_date: day,
      outlets: counts
        .filter((c) => c.outlet_id)
        .map((c) => ({
          ...c,
          outlet_name: displayOutletName(c.outlet_name),
        })),
      exceptions,
    };
  }

  /**
   * One-click human override of an AI reject. Without this the board fills with
   * permanent red nobody can close - handwritten talkers, promos the data
   * doesn't reflect yet, glare.
   */
  async overrideProof(id, review_note, reviewed_by) {
    const proof = await this.talkerRepo.getProofById(id);
    if (!proof) {
      return { code: 404, msg: "Proof not found" };
    }
    await this.talkerRepo.reviewProof(id, {
      status: "overridden",
      reviewed_by,
      review_note,
    });
    // An overridden reject is settled: stop asking for it.
    await this.talkerRepo.setLocationQueueState(proof.location_id, {
      pending_tier: null,
      pending_since: null,
      last_accepted_at: new Date(),
    });
    return { code: 200 };
  }

  async confirmReject(id, review_note, reviewed_by) {
    const proof = await this.talkerRepo.getProofById(id);
    if (!proof) {
      return { code: 404, msg: "Proof not found" };
    }
    await this.talkerRepo.reviewProof(id, {
      status: "rejected",
      reviewed_by,
      review_note,
    });
    // Confirmed bad: it stays at the top of that outlet's queue until re-shot.
    await this.talkerRepo.setLocationQueueState(proof.location_id, {
      pending_tier: TIER_FLAGGED,
      pending_since: new Date(),
    });
    return { code: 200 };
  }

  // ---------------------------------------------------------------------
  // Printing the physical talkers
  // ---------------------------------------------------------------------

  /**
   * One card per sign to print. A group normally yields exactly one card; a
   * group whose articles carry different offers yields one card per distinct
   * offer and is flagged mixed, because a single sign cannot honestly
   * advertise two different discounts.
   *
   * Articles whose offer has since ended are dropped rather than printed - a
   * talker for a dead offer is worse than no talker at all.
   */
  async getPrintCards({ status, group_type } = {}) {
    const rows = await this.talkerRepo.listPrintData({ status, group_type });

    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.group_id)) {
        groups.set(row.group_id, { meta: row, offers: new Map(), dropped: [] });
      }
      const g = groups.get(row.group_id);
      const wording = talkerWording(row.offer_type, row.value);
      if (!wording) {
        g.dropped.push(row.item_name || `Item ${row.item_code}`);
        continue;
      }
      const key = `${row.offer_type}|${row.value}`;
      if (!g.offers.has(key)) {
        g.offers.set(key, {
          offer_type: row.offer_type,
          value: row.value,
          wording,
          items: [],
        });
      }
      g.offers.get(key).items.push({
        item_code: row.item_code,
        item_name: row.item_name,
      });
    }

    const cards = [];
    for (const { meta, offers, dropped } of groups.values()) {
      const mixed = offers.size > 1;
      for (const offer of offers.values()) {
        const text = printedText(offer.wording);
        // A brand sign is read as that supplier's block, so it carries the
        // supplier name. An individual sign covers one article, so it carries
        // the product name instead.
        const title =
          meta.group_type === "individual"
            ? offer.items[0]?.item_name || meta.label
            : meta.supplier || meta.label;
        cards.push({
          group_id: meta.group_id,
          group_type: meta.group_type,
          status: meta.status,
          label: meta.label,
          title,
          headline: offer.wording.headline,
          subline: offer.wording.subline,
          offer_type: offer.offer_type,
          value: offer.value,
          active_to: meta.active_to,
          item_count: offer.items.length,
          items: offer.items,
          printed_text: text,
          // The photo check compares what is on the shelf against talker_text.
          // If those two disagree, every photo of a correctly-placed sign
          // fails, so the mismatch has to be visible before anything prints.
          expected_text: meta.talker_text || null,
          expected_text_matches:
            !meta.talker_text || String(meta.talker_text).trim() === text,
          mixed,
          dropped_items: dropped,
        });
      }
    }
    return { code: 200, cards };
  }

  /**
   * Records what the printed sign actually says, so the photo check has
   * something true to compare against. Skips mixed groups: there is no single
   * expected text for a group printing two different signs.
   */
  async syncExpectedText(group_ids) {
    const ids = Array.isArray(group_ids) ? group_ids : [];
    if (!ids.length) return { code: 422, msg: "No groups selected" };

    const { cards } = await this.getPrintCards({});
    const chosen = cards.filter((c) => ids.includes(c.group_id));

    let updated = 0;
    // A mixed group yields several cards, so it would otherwise be reported
    // skipped once per card.
    const skipped = new Set();
    for (const card of chosen) {
      if (card.mixed) {
        skipped.add(card.label);
        continue;
      }
      if (card.expected_text === card.printed_text) continue;
      await this.talkerRepo.setTalkerText(card.group_id, card.printed_text);
      updated += 1;
    }
    return { code: 200, updated, skipped: [...skipped] };
  }
}

/**
 * Offer values are DECIMAL(12,2), so a 22% offer arrives as "22.00". A shelf
 * talker reading "22.00% OFF" looks like a mistake, so trailing zeros go.
 */
function printNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

/**
 * The wording for each kind of offer, fixed by the people who read the sign:
 * a percentage is "% off on MRP", a flat discount is what you save off MRP,
 * and a fixed price is a special price - it carries no MRP reference because
 * the offer replaces the price rather than discounting it.
 *
 * None of the three needs the outlet's selling price, which is what makes one
 * print run valid across every outlet.
 */
function talkerWording(offer_type, value) {
  const num = printNumber(value);
  if (num === null) return null;
  if (offer_type === "percentage") {
    return { headline: `${num}% OFF`, subline: "ON MRP" };
  }
  if (offer_type === "flat") {
    return { headline: `SAVE \u20b9${num}`, subline: "ON MRP" };
  }
  if (offer_type === "fixed_price") {
    return { headline: `SPL PRICE \u20b9${num}`, subline: null };
  }
  return null;
}

function printedText({ headline, subline }) {
  return subline ? `${headline} ${subline}` : headline;
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch (err) {
    logError("PARSE_AI_JSON", err.toString(), {});
    return null;
  }
}

module.exports = (talkerRepo, outletRepo) => {
  return new OffersV3TalkerUsecase(talkerRepo, outletRepo);
};

module.exports.deriveGroupingKey = groupingKey;
module.exports.displayOutletName = displayOutletName;
module.exports.talkerWording = talkerWording;
