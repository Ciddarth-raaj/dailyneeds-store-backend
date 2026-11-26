/**
 * Stock Audit - SPECTRA queries for the three RetailPilot (runway) streams,
 * read by keyset paging (services/retailpilot_spectra.js queryKeyset).
 *
 *   session     public.stock_audit_count_session  by (updated_at, slug)
 *   line        public.stock_audit_count_line     by (updated_at, slug)
 *   adjustment  public.stock_ledgers, STK_ADJ     by (ts, slug)
 *
 * SPECTRA rules these queries respect (observed live, see the discovery
 * report): SELECT only, no subqueries, no OFFSET, no positional GROUP BY /
 * ORDER BY (they fail with a 500), at most 2,000 rows a page.
 *
 * Timestamps come back as ISO strings with MICROSECONDS and an offset
 * ("2026-11-26T21:57:30.073153+05:30"). A JS Date keeps only milliseconds, so
 * a cursor built from a Date would re-read or skip rows inside the same
 * millisecond. Cursors therefore keep timestamps as strings, converted here
 * without going through a Date for the fractional part.
 *
 * Every value put into SQL is validated; anything else throws.
 */

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/;
const SLUG_RE = /^[A-Za-z0-9_-]{0,64}$/;

/** Overlap re-read on every incremental run, so late commits are not missed. */
const DEFAULT_OVERLAP_MINUTES = 30;
const PAGE_SIZE = 2000;

/**
 * Any accepted timestamp -> UTC, microsecond precision.
 * @returns { iso: "2026-11-26T16:27:30.073153Z", sql: "2026-11-26 16:27:30.073153", micros: "073153" }
 */
function toUtc(value) {
  const m = TS_RE.exec(String(value == null ? "" : value).trim());
  if (!m) throw new Error(`Not a timestamp: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s, frac = "", zone = "Z"] = m;
  const micros = (frac + "000000").slice(0, 6);
  let offsetMin = 0;
  if (zone !== "Z") {
    const z = zone.replace(":", "");
    offsetMin = (z[0] === "-" ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMin * 60000;
  const base = new Date(ms).toISOString().slice(0, 19); // whole seconds, UTC
  return { iso: `${base}.${micros}Z`, sql: `${base.replace("T", " ")}.${micros}`, micros };
}

/** Compare two timestamps exactly (microseconds included). */
function compareTs(a, b) {
  const x = toUtc(a).iso;
  const y = toUtc(b).iso;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A timestamp moved back by `minutes`, microseconds kept. */
function minusMinutes(value, minutes) {
  const u = toUtc(value);
  const ms = Date.parse(`${u.iso.slice(0, 19)}Z`) - minutes * 60000;
  return `${new Date(ms).toISOString().slice(0, 19)}.${u.micros}Z`;
}

function checkSlug(slug) {
  const s = slug == null ? "" : String(slug);
  if (!SLUG_RE.test(s)) throw new Error(`Not a RetailPilot slug: ${JSON.stringify(slug)}`);
  return s;
}

/**
 * The cursor a stream starts from: its stored watermark minus the overlap,
 * with an empty slug so every row AT that instant is read again. No
 * watermark (first run / historical import) -> `since`, or the beginning.
 */
function startCursor(watermark, { overlapMinutes = DEFAULT_OVERLAP_MINUTES, since = null } = {}) {
  if (watermark && watermark.ts) return { ts: minusMinutes(watermark.ts, overlapMinutes), slug: "" };
  if (since) return { ts: toUtc(since).iso, slug: "" };
  return null;
}

function after(col, cursor) {
  if (!cursor) return "TRUE";
  const ts = toUtc(cursor.ts).iso;
  const slug = checkSlug(cursor.slug);
  return `(${col} > '${ts}' OR (${col} = '${ts}' AND slug > '${slug}'))`;
}

function limit(size) {
  const n = Number(size) || PAGE_SIZE;
  if (!Number.isInteger(n) || n < 1 || n > PAGE_SIZE) throw new Error(`Bad page size ${size}`);
  return n;
}

const STREAMS = {
  session: {
    tsColumn: "updated_at",
    build(cursor, size) {
      return `SELECT slug, store_id, article_id, stock_location, status, initiated_by, finalized_by,
       started_at, finalized_at, updated_at, net_adj_action, marker_ledger_slug, recount_slug, cancel_reason
FROM public.stock_audit_count_session
WHERE ${after("updated_at", cursor)}
ORDER BY updated_at ASC, slug ASC
LIMIT ${limit(size)}`;
    },
    cursorOf: (row) => ({ ts: row.updated_at, slug: row.slug }),
  },
  line: {
    tsColumn: "updated_at",
    build(cursor, size) {
      return `SELECT slug, session_slug, stock_location, batch_id, mrp, counted_qty, snapshot_qty, snapshot_cells,
       source, holding_type, status, created_at, updated_at
FROM public.stock_audit_count_line
WHERE ${after("updated_at", cursor)}
ORDER BY updated_at ASC, slug ASC
LIMIT ${limit(size)}`;
    },
    cursorOf: (row) => ({ ts: row.updated_at, slug: row.slug }),
  },
  adjustment: {
    tsColumn: "ts",
    build(cursor, size) {
      // stock_ledgers is large (a full COUNT took 8 s): never read it unbounded.
      if (!cursor) throw new Error("The adjustment stream needs a start cursor (a watermark or a since date)");
      return `SELECT slug, article_id, store_id, batch_id, stock_location, action, ts, quantity, net_landing_cost, mrp, traceability
FROM public.stock_ledgers
WHERE action = 'STK_ADJ' AND ${after("ts", cursor)}
ORDER BY ts ASC, slug ASC
LIMIT ${limit(size)}`;
    },
    cursorOf: (row) => ({ ts: row.ts, slug: row.slug }),
  },
};

module.exports = { STREAMS, PAGE_SIZE, DEFAULT_OVERLAP_MINUTES, toUtc, compareTs, minusMinutes, startCursor };
