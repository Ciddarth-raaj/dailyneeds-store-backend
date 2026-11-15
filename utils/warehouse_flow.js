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
  i.updated_at AS inspection_updated_at,
  i.supplier_invoice_id, i.invoice_amount, i.po_id, i.invoice_id`;

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
        updated_at: iso(r.inspection_updated_at),
        supplier_invoice_id: clean(r.supplier_invoice_id) || null,
        invoice_amount: num(r.invoice_amount),
        po_id: clean(r.po_id) || null,
        grn_started: Boolean(clean(r.invoice_id)),
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

// Inspection states that are finished. Anything else is still being inspected.
const DONE_STATES = ["COMPLETED", "WRITTEN_OFF"];
const WRITTEN_OFF_DAYS = 30;

/**
 * Inspections the flow needs that are not on an open gate pass's row: still
 * in progress, completed with no GRN yet, or written off lately - whatever
 * their gate pass says (many passes are never closed, and some inspections
 * have none). invoice_id is set once the GRN is started; the GRN is done
 * when the gate pass closes.
 */
function buildActiveInspectionsQuery() {
  return `
SELECT i.slug, i.state, i.store_id, i.supplier_id, i.created_at, i.updated_at,
  i.supplier_invoice_id, i.invoice_amount, i.po_id, i.invoice_id, i.gatepass_slug,
  g.status AS gate_status, g.vehicle_number, g.entry_time
FROM public.grn_inspection_header i
LEFT JOIN public.gate_passes g ON g.slug = i.gatepass_slug
WHERE i.state NOT IN ('COMPLETED', 'WRITTEN_OFF')
   OR (i.state = 'COMPLETED' AND i.invoice_id IS NULL)
   OR (i.state = 'WRITTEN_OFF' AND i.updated_at >= CURRENT_DATE - ${WRITTEN_OFF_DAYS})
ORDER BY i.created_at, i.slug`;
}

/** One inspection, with its gate pass when it has one. */
function buildInspectionQuery(slug) {
  const s = validSlug(slug);
  if (!s) throw new Error("Invalid inspection");
  return `
SELECT i.slug, i.state, i.store_id, i.supplier_id, i.created_at, i.updated_at, i.updated_by,
  i.supplier_invoice_id, i.invoice_amount, i.po_id, i.invoice_id, i.gatepass_slug,
  g.status AS gate_status, g.vehicle_number, g.driver_name, g.driver_phone, g.entry_time, g.exit_time
FROM public.grn_inspection_header i
LEFT JOIN public.gate_passes g ON g.slug = i.gatepass_slug
WHERE i.slug = '${s}'`;
}

/** Inspection rows -> [{ slug, state, store, supplier, times, gate pass, grn_started }]. */
function mapInspectionRows(rows, vendorRows, resolve) {
  const vendors = new Map((vendorRows || []).map((v) => [clean(v.id), clean(v.name)]));
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const slug = clean(r.slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      state: clean(r.state).toUpperCase() || null,
      store: resolve(r.store_id, null).key,
      supplier_id: clean(r.supplier_id) || null,
      supplier_name: vendors.get(clean(r.supplier_id)) || null,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      updated_by: clean(r.updated_by) || null,
      supplier_invoice_id: clean(r.supplier_invoice_id) || null,
      invoice_amount: num(r.invoice_amount),
      po_id: clean(r.po_id) || null,
      grn_started: Boolean(clean(r.invoice_id)),
      gate_pass: clean(r.gatepass_slug) || null,
      gate_status: clean(r.gate_status).toUpperCase() || null,
      vehicle_number: clean(r.vehicle_number) || null,
      driver_name: clean(r.driver_name) || null,
      driver_phone: clean(r.driver_phone) || null,
      entry_time: iso(r.entry_time),
      exit_time: iso(r.exit_time),
    });
  }
  return out;
}

const finished = (state) => DONE_STATES.includes(String(state || "").toUpperCase());

// Invoice document states (public.invoice_documents.state). `digitized` is
// the GRN done; cancelled and duplicate ones never become a GRN.
const DOC_DONE = "digitized";
const DOC_DROPPED = ["cancelled", "duplicate_invoice"];
const DOC_NOT_STARTED = "no_template";

/**
 * The supplier invoices (RetailPilot's invoice documents) the flow needs:
 * every one not yet GRN'd, and every one on a gate pass still OPEN (so a
 * pass whose invoices are all done is known to be done). Named columns only:
 * the document's scanned data is large and not needed.
 */
function buildDocumentsQuery() {
  return `
SELECT d.slug, d.state, d.store_id, d.supplier_id, d.document_id, d.document_date,
  d.uploaded_at, d.state_updated_at, d.gatepass_slug, d.error_message, d.invoice_slug
FROM public.invoice_documents d
LEFT JOIN public.gate_passes g ON g.slug = d.gatepass_slug
WHERE d.state NOT IN ('digitized', 'cancelled', 'duplicate_invoice')
   OR g.status = 'OPEN'
ORDER BY d.uploaded_at, d.slug`;
}

/** One gate pass's invoices, whatever their state. */
function buildGatePassDocumentsQuery(gatePassSlug) {
  const s = validSlug(gatePassSlug);
  if (!s) throw new Error("Invalid gate pass");
  return `
SELECT d.slug, d.state, d.store_id, d.supplier_id, d.document_id, d.document_date,
  d.uploaded_at, d.state_updated_at, d.gatepass_slug, d.error_message, d.invoice_slug
FROM public.invoice_documents d
WHERE d.gatepass_slug = '${s}'
ORDER BY d.uploaded_at, d.slug`;
}

/** Document rows -> [{ slug, state, store, supplier, invoice_no, dates, gate_pass, ... }]. */
function mapDocumentRows(rows, vendorRows, resolve) {
  const vendors = new Map((vendorRows || []).map((v) => [clean(v.id), clean(v.name)]));
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const slug = clean(r.slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const state = clean(r.state).toLowerCase() || null;
    out.push({
      slug,
      state,
      done: state === DOC_DONE,
      dropped: DOC_DROPPED.includes(state),
      grn_started: state !== DOC_NOT_STARTED,
      store: resolve(r.store_id, null).key,
      supplier_id: clean(r.supplier_id) || null,
      supplier_name: vendors.get(clean(r.supplier_id)) || null,
      invoice_no: clean(r.document_id) || null,
      invoice_date: iso(r.document_date),
      uploaded_at: iso(r.uploaded_at),
      state_updated_at: iso(r.state_updated_at),
      gate_pass: clean(r.gatepass_slug) || null,
      message: clean(r.error_message) || null,
      grn_ref: clean(r.invoice_slug) || null,
    });
  }
  return out;
}

const pendingDocs = (docs) => (docs || []).filter((d) => !d.done && !d.dropped);
const earliest = (values) => values.filter(Boolean).sort()[0] || null;

/**
 * Where each consignment is, by what has happened to it:
 *
 *   gate_pass    gate pass OPEN, no inspection and no invoice uploaded yet
 *   inspection   an inspection not yet COMPLETED or WRITTEN_OFF
 *   grn          one row per supplier invoice not yet GRN'd (digitized), with
 *                its gate pass when it has one - with or without an
 *                inspection (direct purchases have none). An invoice is
 *                "started" once it is past no_template. This is what
 *                RetailPilot's invoice screen lists.
 *   no_invoice   gate pass OPEN, inspection COMPLETED, but no invoice uploaded
 *   written_off  inspections written off in the last 30 days
 *
 * Each row: { ref, kind: "gate_pass" | "inspection" | "document", gate_pass,
 * inspection, store, supplier_id, supplier_name, vehicle_number, since,
 * state, grn_started, invoices, invoices_grn_started, invoice_amount,
 * documents }. `since` is when it entered this step, as near as RetailPilot
 * records it; `documents` are the invoices still waiting for their GRN.
 */
function classifyFlow(passes, inspections, documents) {
  const docsByPass = new Map();
  for (const d of documents || []) {
    if (!d.gate_pass) continue;
    if (!docsByPass.has(d.gate_pass)) docsByPass.set(d.gate_pass, []);
    docsByPass.get(d.gate_pass).push(d);
  }
  const grnFields = (waiting) => ({
    grn_started: waiting.some((d) => d.grn_started),
    invoices: waiting.length,
    invoices_grn_started: waiting.filter((d) => d.grn_started).length,
    invoice_amount: null,
    documents: waiting,
  });
  const fromPass = (p, since, extra) => ({
    ref: p.slug,
    kind: "gate_pass",
    gate_pass: p.slug,
    inspection: p.inspections.length ? p.inspections[p.inspections.length - 1].slug : null,
    store: p.store,
    supplier_id: p.supplier_id,
    supplier_name: p.supplier_name,
    vehicle_number: p.vehicle_number,
    since,
    state: p.inspections.length ? p.inspections.map((i) => i.state).join(", ") : null,
    grn_started: false,
    invoices: 0,
    invoices_grn_started: 0,
    invoice_amount: null,
    documents: [],
    ...extra,
  });
  const fromInspection = (i, since) => ({
    ref: i.slug,
    kind: "inspection",
    gate_pass: i.gate_pass,
    inspection: i.slug,
    store: i.store,
    supplier_id: i.supplier_id,
    supplier_name: i.supplier_name,
    vehicle_number: i.vehicle_number,
    since,
    state: i.state,
    grn_started: false,
    invoices: 0,
    invoices_grn_started: 0,
    invoice_amount: null,
    documents: [],
  });
  const fromDocument = (d, p) => ({
    ref: d.slug,
    kind: "document",
    gate_pass: d.gate_pass,
    inspection: p && p.inspections.length ? p.inspections[p.inspections.length - 1].slug : null,
    store: d.store,
    supplier_id: d.supplier_id || (p && p.supplier_id) || null,
    supplier_name: d.supplier_name || (p && p.supplier_name) || null,
    vehicle_number: p ? p.vehicle_number : null,
    invoice_no: d.invoice_no,
    doc_state: d.state,
    since: d.uploaded_at,
    state: d.state,
    ...grnFields([d]),
  });

  const gate_pass = [];
  const grn = [];
  const no_invoice = [];
  const listedPasses = new Set();
  for (const p of passes || []) {
    if (p.status && p.status !== "OPEN") continue;
    const docs = docsByPass.get(p.slug) || [];
    const waiting = pendingDocs(docs);
    // Still being inspected: it shows under Inspection, from the inspection itself.
    if (p.inspections.some((i) => !finished(i.state))) continue;
    if (waiting.length) {
      // One row per invoice, not per gate pass: a vehicle with three
      // invoices is three GRNs to do.
      waiting.forEach((d) => grn.push(fromDocument(d, p)));
      listedPasses.add(p.slug);
      continue;
    }
    const liveDocs = docs.filter((d) => !d.dropped);
    if (!p.inspections.length && !liveDocs.length) {
      gate_pass.push(fromPass(p, p.entry_time));
      continue;
    }
    const completed = p.inspections.filter((i) => i.state === "COMPLETED");
    // Inspected, but nothing uploaded to GRN against this pass.
    if (completed.length && !liveDocs.length) {
      no_invoice.push(fromPass(p, earliest(completed.map((i) => i.updated_at || i.created_at)) || p.entry_time));
    }
    // Otherwise every invoice is GRN'd (the pass just was not closed yet) or
    // every inspection was written off: nothing waits here.
  }
  // Invoices waiting for a GRN with no open gate pass to carry them.
  for (const d of pendingDocs(documents)) {
    if (d.gate_pass && listedPasses.has(d.gate_pass)) continue;
    grn.push(fromDocument(d));
  }

  const inspection = [];
  const written_off = [];
  for (const i of inspections || []) {
    if (!finished(i.state)) inspection.push(fromInspection(i, i.created_at));
    else if (i.state === "WRITTEN_OFF") written_off.push(fromInspection(i, i.updated_at || i.created_at));
  }
  return { gate_pass, inspection, grn, no_invoice, written_off };
}

/** The stages, in order. Only `built` stages are read. */
const STAGES = [
  { key: "gate_pass", label: "Gate pass", built: true, hint: "In through the gate; not inspected and no invoice uploaded yet" },
  { key: "inspection", label: "Inspection", built: true, hint: "Being inspected" },
  { key: "grn", label: "GRN", built: true, hint: "Supplier invoices waiting for their GRN" },
  { key: "allocation", label: "Allocation", built: false },
  { key: "ready_to_dispatch", label: "Ready to dispatch", built: false },
];

/** Lists outside the flow that need somebody to act. */
const ATTENTION = [
  { key: "no_invoice", label: "Inspected, invoice not uploaded", hint: "Inspection done, but no supplier invoice uploaded for the GRN" },
  { key: "written_off", label: "Written off", hint: `Inspections written off in the last ${WRITTEN_OFF_DAYS} days` },
];

module.exports = {
  STAGES,
  buildDocumentsQuery,
  buildGatePassDocumentsQuery,
  mapDocumentRows,
  ATTENTION,
  WRITTEN_OFF_DAYS,
  buildActiveInspectionsQuery,
  buildInspectionQuery,
  mapInspectionRows,
  classifyFlow,
  validSlug,
  buildOpenGatePassesQuery,
  buildGatePassQuery,
  buildInspectionTotalsQuery,
  buildVendorNamesQuery,
  mapGatePassRows,
  mapInspectionTotals,
};
