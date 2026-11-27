const crypto = require("crypto");

/**
 * BULK allotment import - backend (authoritative) copy of the rules the
 * screen previews (dailyneeds-store components/stockAudit/data/bulkAllotment.js).
 *
 * RetailPilot "assortment-effective" CSVs, one file
 * per auditor, many files in one action. Pure (no React, no network).
 *
 * The format is RetailPilot's own export, unmodified:
 *   Store, Store name, Auditor, Auditor name, Node, Level, Article ID,
 *   Article, Owned, Positive stock, Negative stock, Net stock, Sellable,
 *   Buyable, Effective, Reason
 *
 *   - store and auditor come from the file's CONTENTS (Store, Auditor),
 *     never from its name
 *   - Effective = Y  -> allotted (auditable, can earn the article incentive)
 *     Effective = N  -> NOT AUDITABLE: never allotted, never paid
 *   - stock columns are book stock and are ignored
 *   - a newer file for an auditor already imported in the cycle is that
 *     auditor's next REVISION; it replaces that auditor's allotment only
 *   - audits are matched on Store ID + Auditor ID + Article ID
 */

const REQUIRED = ["Store", "Auditor", "Article ID", "Effective"];
const OPTIONAL = ["Store name", "Auditor name", "Node", "Level", "Article", "Reason"];

const norm = (v) => String(v == null ? "" : v).trim();

/** Parse CSV text (RetailPilot quotes fields that contain commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] == null ? "" : r[i]]))) };
}

/** A stable fingerprint of a file's allotment content (store, auditor, article, effective): sha1, order-independent. */
function fingerprint(rows) {
  const lines = rows.map((r) => `${norm(r.Store)}|${norm(r.Auditor)}|${norm(r["Article ID"])}|${norm(r.Effective).toUpperCase()}`).sort();
  return crypto.createHash("sha1").update(lines.join("\n")).digest("hex");
}

/**
 * Read ONE file: identify its store and auditor from the contents.
 * @returns { name, ok, errors, store_id, store_name, auditor_id, auditor_name, rows, auditable, not_auditable, fp }
 */
function readAuditorFile(name, text) {
  const { headers, rows } = parseCsv(text);
  const errors = [];
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) errors.push(`Not a RetailPilot assortment-effective file: missing ${missing.join(", ")}`);
  if (!rows.length) errors.push("No rows");
  const stores = [...new Set(rows.map((r) => norm(r.Store)).filter(Boolean))];
  const auditors = [...new Set(rows.map((r) => norm(r.Auditor)).filter(Boolean))];
  if (!missing.length && stores.length !== 1) errors.push(stores.length ? `More than one store in the file (${stores.join(", ")})` : "Store missing");
  if (!missing.length && auditors.length !== 1) errors.push(auditors.length ? `More than one auditor in the file (${auditors.join(", ")})` : "Auditor missing");
  const lines = rows.map((r, i) => {
    const article = norm(r["Article ID"]);
    const eff = norm(r.Effective).toUpperCase();
    const e = [];
    if (!/^\d+$/.test(article)) e.push(`Article ID "${article}" is not valid`);
    if (eff !== "Y" && eff !== "N") e.push(`Effective "${r.Effective}" is not Y or N`);
    return { line: i + 2, article_id: article, article: norm(r.Article), node: norm(r.Node), auditable: eff === "Y", reason: norm(r.Reason), errors: e };
  });
  const seen = new Map();
  for (const l of lines) {
    if (!l.article_id) continue;
    if (seen.has(l.article_id)) l.errors.push(`Repeated in this file (line ${seen.get(l.article_id)})`);
    else seen.set(l.article_id, l.line);
  }
  return {
    name,
    errors,
    ok: !errors.length,
    store_id: stores[0] || null,
    store_name: rows[0] ? norm(rows[0]["Store name"]) : null,
    auditor_id: auditors[0] || null,
    auditor_name: rows[0] ? norm(rows[0]["Auditor name"]) : null,
    lines,
    rows: rows.length,
    auditable: lines.filter((l) => l.auditable && !l.errors.length).length,
    not_auditable: lines.filter((l) => !l.auditable && !l.errors.length).length,
    line_errors: lines.filter((l) => l.errors.length).length,
    fp: fingerprint(rows),
  };
}

/**
 * Validate a whole upload for one audit cycle.
 * @param files    readAuditorFile() results
 * @param ctx.cycleStores   Set of RetailPilot store IDs in the cycle (warehouse never)
 * @param ctx.storeOf       (rpStoreId) => { outlet_id, name } | null      Branch Master
 * @param ctx.employeeOf    (rpUserId)  => employee | null                 RetailPilot staff map
 * @param ctx.current       Map auditorKey("store|auditor") -> { revision, fp, articles: Map(article -> true) }  accepted allotment in this cycle
 * @param ctx.audits        [{ rp_store_id, rp_user_id, article_id }] finalized audits in the cycle (programme start onwards)
 */
function validateBatch(files, ctx) {
  const out = files.map((f) => ({ ...f, status: "VALID", issues: [...f.errors], warnings: [] }));
  const key = (f) => `${f.store_id}|${f.auditor_id}`;

  // 1. per file: store, cycle, mapping, already imported
  const fpSeen = new Map();
  const auditorSeen = new Map();
  for (const f of out) {
    if (!f.ok) { f.status = "REJECTED"; continue; }
    const store = ctx.storeOf(f.store_id);
    f.outlet = store;
    if (!store) f.issues.push(`Store ${f.store_id} is not in Branch Master`);
    else if (!ctx.cycleStores.has(f.store_id)) f.issues.push(`${store.name} is not taking part in this season`);
    if (fpSeen.has(f.fp)) f.issues.push(`Same content as ${fpSeen.get(f.fp)} in this upload`);
    else fpSeen.set(f.fp, f.name);
    if (auditorSeen.has(key(f))) {
      if (!f.issues.some((i) => i.startsWith("Same content"))) f.issues.push(`${f.auditor_name || f.auditor_id} is also in ${auditorSeen.get(key(f))}: keep one file per auditor`);
    } else auditorSeen.set(key(f), f.name);
    const cur = ctx.current.get(key(f));
    if (cur && cur.fp === f.fp) { f.status = "ALREADY_IMPORTED"; f.revision = cur.revision; }
    else f.revision = cur ? cur.revision + 1 : 1;
    f.employee = ctx.employeeOf(f.auditor_id);
    if (!f.employee) f.warnings.push(`RetailPilot user ${f.auditor_id} (${f.auditor_name || "no name"}) is not mapped to an employee`);
    if (f.issues.length) f.status = "REJECTED";
  }

  // 2. conflicts: one auditable article allotted to two auditors in a store.
  //    Already-imported allotments of auditors NOT re-uploaded take part too.
  const owner = new Map(); // "store|article" -> auditor
  // Auditors whose allotment this upload REPLACES (a file identical to the
  // earlier import replaces nothing: that import stays in force).
  const reuploaded = new Set(out.filter((f) => f.status !== "REJECTED" && f.status !== "ALREADY_IMPORTED").map(key));
  for (const [k, cur] of ctx.current) {
    if (reuploaded.has(k)) continue;
    const [store, auditor] = k.split("|");
    for (const a of cur.articles.keys()) owner.set(`${store}|${a}`, { auditor, file: "earlier import" });
  }
  const conflicts = [];
  for (const f of out) {
    if (f.status === "REJECTED" || f.status === "ALREADY_IMPORTED") continue;
    for (const l of f.lines) {
      if (!l.auditable || l.errors.length) continue;
      const k = `${f.store_id}|${l.article_id}`;
      const o = owner.get(k);
      if (o && o.auditor !== f.auditor_id) {
        l.errors.push(`Also allotted to ${o.auditor} (${o.file})`);
        conflicts.push({ store_id: f.store_id, article_id: l.article_id, auditors: [o.auditor, f.auditor_id], files: [o.file, f.name] });
      } else owner.set(k, { auditor: f.auditor_id, file: f.name });
    }
    f.conflicts = f.lines.filter((l) => l.errors.some((e) => e.startsWith("Also allotted"))).length;
    if (f.conflicts) f.status = "CONFLICT";
    else if (f.status === "VALID" && (f.lines.some((l) => l.errors.length) || f.warnings.length)) f.status = "WARNINGS";
  }

  // 3. revisions: what a corrected file changes for THAT auditor
  for (const f of out) {
    const cur = ctx.current.get(key(f));
    if (!cur || f.status === "REJECTED" || f.status === "ALREADY_IMPORTED") { f.diff = null; continue; }
    const next = new Set(f.lines.filter((l) => l.auditable && !l.errors.length).map((l) => l.article_id));
    const prev = new Set(cur.articles.keys());
    f.diff = {
      added: [...next].filter((a) => !prev.has(a)).length,
      removed: [...prev].filter((a) => !next.has(a)).length,
      unchanged: [...next].filter((a) => prev.has(a)).length,
    };
  }

  // 4. match with actual audits: Store ID + Auditor ID + Article ID
  const allotted = new Map(); // store|article -> auditor
  for (const [k, cur] of ctx.current) {
    if (reuploaded.has(k)) continue;
    const [store, auditor] = k.split("|");
    for (const a of cur.articles.keys()) allotted.set(`${store}|${a}`, auditor);
  }
  for (const f of out) {
    if (f.status === "REJECTED") continue;
    for (const l of f.lines) if (l.auditable && !l.errors.length) allotted.set(`${f.store_id}|${l.article_id}`, f.auditor_id);
  }
  const perAuditor = new Map();
  const bump = (k, field) => { if (!perAuditor.has(k)) perAuditor.set(k, { audited_own: 0, audited_by_other: 0, audited_not_allotted: 0 }); perAuditor.get(k)[field] += 1; };
  for (const a of ctx.audits || []) {
    const owner2 = allotted.get(`${a.rp_store_id}|${a.article_id}`);
    if (!owner2) bump(`${a.rp_store_id}|${a.rp_user_id}`, "audited_not_allotted");
    else if (owner2 === a.rp_user_id) bump(`${a.rp_store_id}|${a.rp_user_id}`, "audited_own");
    else bump(`${a.rp_store_id}|${owner2}`, "audited_by_other");
  }
  for (const f of out) {
    const m = perAuditor.get(key(f)) || { audited_own: 0, audited_by_other: 0, audited_not_allotted: 0 };
    f.match = { ...m, pending: Math.max(0, f.auditable - m.audited_own - m.audited_by_other) };
  }

  const importable = out.filter((f) => f.status === "VALID" || f.status === "WARNINGS");
  return {
    files: out,
    conflicts,
    summary: {
      files: out.length,
      importable: importable.length,
      rejected: out.filter((f) => f.status === "REJECTED").length,
      conflict_files: out.filter((f) => f.status === "CONFLICT").length,
      already_imported: out.filter((f) => f.status === "ALREADY_IMPORTED").length,
      revisions: importable.filter((f) => f.revision > 1).length,
      stores: [...new Set(out.map((f) => f.store_id).filter(Boolean))].length,
      auditors: [...new Set(out.map((f) => f.auditor_id).filter(Boolean))].length,
      unmapped: [...new Set(out.filter((f) => f.status !== "REJECTED" && !f.employee).map((f) => f.auditor_id))].length,
      rows: out.reduce((t, f) => t + f.rows, 0),
      auditable: importable.reduce((t, f) => t + f.auditable, 0),
      not_auditable: out.reduce((t, f) => t + f.not_auditable, 0),
      line_errors: out.reduce((t, f) => t + f.lines.filter((l) => l.errors.length).length, 0),
    },
    canConfirm: importable.length > 0 && out.every((f) => f.status !== "CONFLICT"),
  };
}


module.exports = { REQUIRED, OPTIONAL, parseCsv, fingerprint, readAuditorFile, validateBatch };
