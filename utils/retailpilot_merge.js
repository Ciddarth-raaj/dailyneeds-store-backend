/**
 * Re-syncing a RetailPilot bill without losing Accounts' corrections.
 *
 * Accounts correct a bill on the Purchase screen (GSTIN, dates, tax, ...),
 * which writes the same `purchase` columns the sync writes. So the sync keeps,
 * in purchase.retailpilot_source, the values it last wrote. On the next
 * change from RetailPilot each field is three-way merged:
 *
 *   current == last synced  -> Accounts have not touched it: take RetailPilot's
 *   current != last synced  -> Accounts corrected it: keep theirs
 *
 * and a field RetailPilot changed while Accounts' value was kept is reported
 * (`kept`), so the bill is flagged for a second look rather than silently
 * diverging. The round-off the sync pre-filled into purchase_internal is
 * handled the same way: refreshed only while it is still the sync's own.
 *
 * Approved bills never reach this: they are frozen (repository/purchase.js).
 */

const { dayOf } = require("./purchase_discrepancy");

/** Columns merged one by one. */
const FIELDS = [
  "supplier_id",
  "supplier_name",
  "supplier_gstn",
  "mmh_mrc_dt",
  "mmh_mrc_amt",
  "mmh_dist_bill_dt",
  "mmh_dist_bill_no",
  "mmh_manual_disc",
  "mmd_goods_tcs_amt",
];

/** Columns merged as one unit, `tax`: the lines and totals belong together. */
const TAX_FIELDS = [
  "tot_sgst_amt",
  "tot_cgst_amt",
  "tot_igst_amt",
  "tot_gst_cess_amt",
  "sgst",
  "cgst",
  "igst",
  "cess",
];

const DATE_FIELDS = new Set(["mmh_mrc_dt", "mmh_dist_bill_dt"]);
const NUMBER_FIELDS = new Set(["mmh_mrc_amt", "mmh_manual_disc", "mmd_goods_tcs_amt"]);

const SOURCE_VERSION = 1;

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  if (v == null || v === "") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

/** One comparable string for the tax unit: lines sorted, numbers to paise. */
function taxKey(row) {
  const lines = (v) =>
    parseList(v)
      .map((l) => [money(l.PERC), money(l.TAXABLE), money(l.VALUE)])
      .filter(([, taxable, value]) => taxable !== 0 || value !== 0)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return JSON.stringify({
    t: ["tot_sgst_amt", "tot_cgst_amt", "tot_igst_amt", "tot_gst_cess_amt"].map((f) => money(row[f])),
    sgst: lines(row.sgst),
    cgst: lines(row.cgst),
    igst: lines(row.igst),
    cess: lines(row.cess),
  });
}

function fieldKey(row, field) {
  const v = row[field];
  if (DATE_FIELDS.has(field)) return dayOf(v);
  if (NUMBER_FIELDS.has(field)) return money(v);
  return v == null ? "" : String(v).trim();
}

/** The comparable form of a purchase row (lowercase columns). */
function sourceOf(row) {
  const out = {};
  for (const f of FIELDS) out[f] = fieldKey(row, f);
  out.tax = taxKey(row);
  return out;
}

function parseSource(text) {
  if (!text) return null;
  try {
    const s = typeof text === "string" ? JSON.parse(text) : text;
    return s && s.v === SOURCE_VERSION && s.fields ? s : null;
  } catch (e) {
    return null;
  }
}

/**
 * @param fields  sourceOf() of the values written
 * @param roundOff { round_off, total_amount } the sync wrote to purchase_internal, or null
 * @param kept    fields RetailPilot changed whose Accounts value was kept
 * @param series  { fy, entered_at }: the financial year the bill's ref no is
 *   numbered in, and the day it was entered in RetailPilot
 */
function buildSource(fields, roundOff, kept = [], series = null) {
  return JSON.stringify({ v: SOURCE_VERSION, fields, round_off: roundOff || null, kept, series });
}

/** { fy, entered_at } of a RetailPilot bill, from the snapshot, or {}. */
function seriesOf(sourceText) {
  const source = parseSource(sourceText);
  return (source && source.series) || {};
}

/**
 * @param existing the purchase row as stored (lowercase columns, with
 *   retailpilot_source)
 * @param incoming the RetailPilot values (lowercase columns, normalised)
 * @returns {{ changes: object, kept: string[], fields: object, hasSource: boolean }}
 *   changes: the columns to write (RetailPilot's value where Accounts have
 *   not corrected the field); fields: sourceOf(incoming), the new snapshot.
 *   Without a usable snapshot nothing is known to be the sync's own, so
 *   nothing is overwritten (hasSource false).
 */
function mergeRetailPilotUpdate(existing, incoming) {
  const source = parseSource(existing.retailpilot_source);
  const now = sourceOf(existing);
  const next = sourceOf(incoming);
  const changes = {};
  const kept = [];

  const consider = (key, columns) => {
    if (next[key] === now[key]) return; // nothing to write
    const accountsUntouched = source && source.fields[key] === now[key];
    if (accountsUntouched) {
      for (const c of columns) changes[c] = incoming[c];
    } else if (!source || next[key] !== source.fields[key]) {
      // Accounts' value stays; flag it when RetailPilot moved too.
      kept.push(key);
    }
  };

  for (const f of FIELDS) consider(f, [f]);
  consider("tax", TAX_FIELDS);

  // A correction RetailPilot did not touch this time stays flagged until
  // the two agree again.
  if (source && Array.isArray(source.kept)) {
    for (const k of source.kept) {
      if (!kept.includes(k) && next[k] !== now[k]) kept.push(k);
    }
  }

  return { changes, kept, fields: next, hasSource: !!source };
}

/**
 * Whether purchase_internal still holds exactly what the sync pre-filled
 * (so the sync may refresh it), given the stored snapshot.
 */
function roundOffIsSyncs(internalRow, sourceText) {
  const source = parseSource(sourceText);
  if (!internalRow || !source || !source.round_off) return false;
  return (
    money(internalRow.round_off) === money(source.round_off.round_off) &&
    money(internalRow.total_amount) === money(source.round_off.total_amount)
  );
}

/** Field names Accounts kept against a RetailPilot change, from the snapshot. */
function keptFields(sourceText) {
  const source = parseSource(sourceText);
  return source && Array.isArray(source.kept) ? source.kept : [];
}

module.exports = {
  FIELDS,
  TAX_FIELDS,
  sourceOf,
  parseSource,
  buildSource,
  mergeRetailPilotUpdate,
  roundOffIsSyncs,
  keptFields,
  seriesOf,
};
