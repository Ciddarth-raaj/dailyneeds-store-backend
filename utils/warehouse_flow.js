/**
 * Warehouse Flow - where every consignment is in the warehouse:
 *
 *   1. Gate pass  ->  2. Inspection  ->  3. GRN  ->  4. Allocation  ->  5. Ready to dispatch
 *
 * Read live from RetailPilot runway (SPECTRA). Stage 1 is built; the others
 * follow once their tables are mapped.
 *
 * GATE PASS. public.gate_passes is OPEN from the vehicle's entry until its
 * exit. A GRN inspection started against it carries its slug
 * (grn_inspection_header.gatepass_slug), which is how the next stage will be
 * told apart.
 *
 * SPECTRA runs SQL text and turns literals into parameters: the only values
 * built into a query are a gate pass slug or inspection ids already checked
 * against a strict pattern. No GROUP BY on an expression holding a literal.
 */

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function validSlug(value) {
  const s = clean(value);
  return SLUG_PATTERN.test(s) ? s : null;
}

const GATE_PASS_COLUMNS = `
  g.slug, g.status, g.store_id, g.supplier_id, g.vehicle_number, g.driver_name, g.driver_phone,
  g.entry_time, g.exit_time, g.created_by, g.created_at, g.updated_at,
  i.slug AS inspection_slug, i.state AS inspection_state, i.created_at AS inspection_created_at,
  i.supplier_invoice_id, i.invoice_amount, i.po_id`;

const GATE_PASS_FROM = `
FROM public.gate_passes g
LEFT JOIN public.grn_inspection_header i ON i.gatepass_slug = g.slug`;

/** Every gate pass OPEN now, oldest first, one row per inspection (or one with none). */
function buildOpenGatePassesQuery() {
  return `
SELECT ${GATE_PASS_COLUMNS}
${GATE_PASS_FROM}
WHERE g.status = 'OPEN'
ORDER BY g.entry_time, g.slug`;
}

/** One gate pass, open or closed, with its inspections. */
function buildGatePassQuery(slug) {
  const s = validSlug(slug);
  if (!s) throw new Error("Invalid gate pass");
  return `
SELECT ${GATE_PASS_COLUMNS}
${GATE_PASS_FROM}
WHERE g.slug = '${s}'
ORDER BY i.created_at`;
}

/** Line totals per inspection: lines, inspected, free and rejected units. */
function buildInspectionTotalsQuery(inspectionSlugs) {
  const ids = [...new Set((inspectionSlugs || []).map(validSlug).filter(Boolean))];
  if (!ids.length) return null;
  return `
SELECT d.grn_inspection_id,
  COUNT(*) AS lines,
  COALESCE(SUM(d.invoice_qty), 0) AS invoice_qty,
  COALESCE(SUM(d.inspected_qty), 0) AS inspected_qty,
  COALESCE(SUM(d.free_qty), 0) AS free_qty,
  COALESCE(SUM(d.total_rejected_qty), 0) AS rejected_qty
FROM public.grn_inspection_details d
WHERE d.grn_inspection_id IN (${ids.map((id) => `'${id}'`).join(", ")})
GROUP BY d.grn_inspection_id`;
}

/**
 * Supplier names, read on their own rather than joined: a join between id
 * columns of two different types would fail the whole gate pass query.
 */
function buildVendorNamesQuery() {
  return `
SELECT CAST(v.id AS TEXT) AS id, COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS name
FROM masterhub.vendors v
ORDER BY v.id`;
}

const hoursBetween = (fromIso, toMs) => {
  const t = Date.parse(fromIso);
  return Number.isFinite(t) ? Math.max(0, Math.round(((toMs - t) / 3600000) * 10) / 10) : null;
};

/**
 * Gate pass rows (one per inspection) -> one per pass:
 * { slug, status, store, supplier_id, supplier_name, vehicle_number,
 *   driver_name, driver_phone, entry_time, exit_time, created_by,
 *   open_hours, inspections: [{ slug, state, created_at, supplier_invoice_id,
 *   invoice_amount, po_id }] }
 * open_hours runs to exit_time for a closed pass, else to nowMs.
 */
function mapGatePassRows(rows, vendorRows, resolve, nowMs = Date.now()) {
  const vendors = new Map((vendorRows || []).map((v) => [clean(v.id), clean(v.name)]));
  const passes = new Map();
  for (const r of rows || []) {
    const slug = clean(r.slug);
    if (!slug) continue;
    let p = passes.get(slug);
    if (!p) {
      const entry = iso(r.entry_time);
      const exit = iso(r.exit_time);
      p = {
        slug,
        status: clean(r.status).toUpperCase() || null,
        store: resolve(r.store_id, null).key,
        supplier_id: clean(r.supplier_id) || null,
        supplier_name: vendors.get(clean(r.supplier_id)) || null,
        vehicle_number: clean(r.vehicle_number) || null,
        driver_name: clean(r.driver_name) || null,
        driver_phone: clean(r.driver_phone) || null,
        created_by: clean(r.created_by) || null,
        entry_time: entry,
        exit_time: exit,
        open_hours: hoursBetween(entry, exit ? Date.parse(exit) : nowMs),
        inspections: [],
      };
      passes.set(slug, p);
    }
    const insp = clean(r.inspection_slug);
    if (insp && !p.inspections.some((x) => x.slug === insp)) {
      p.inspections.push({
        slug: insp,
        state: clean(r.inspection_state) || null,
        created_at: iso(r.inspection_created_at),
        supplier_invoice_id: clean(r.supplier_invoice_id) || null,
        invoice_amount: num(r.invoice_amount),
        po_id: clean(r.po_id) || null,
      });
    }
  }
  return [...passes.values()];
}

/** Inspection totals rows -> Map(inspection slug -> { lines, invoice_qty, inspected_qty, free_qty, rejected_qty }). */
function mapInspectionTotals(rows) {
  const out = new Map();
  for (const r of rows || []) {
    out.set(clean(r.grn_inspection_id), {
      lines: num(r.lines) || 0,
      invoice_qty: num(r.invoice_qty) || 0,
      inspected_qty: num(r.inspected_qty) || 0,
      free_qty: num(r.free_qty) || 0,
      rejected_qty: num(r.rejected_qty) || 0,
    });
  }
  return out;
}

/** The stages, in order. Only `built` stages are read. */
const STAGES = [
  { key: "gate_pass", label: "Gate pass", built: true },
  { key: "inspection", label: "Inspection", built: false },
  { key: "grn", label: "GRN", built: false },
  { key: "allocation", label: "Allocation", built: false },
  { key: "ready_to_dispatch", label: "Ready to dispatch", built: false },
];

module.exports = {
  STAGES,
  validSlug,
  buildOpenGatePassesQuery,
  buildGatePassQuery,
  buildInspectionTotalsQuery,
  buildVendorNamesQuery,
  mapGatePassRows,
  mapInspectionTotals,
};
