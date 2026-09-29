/**
 * STO LISTING - bounded, batched, and the same answer.
 *
 *   node --test usecase/stock_transfer_out.test.js
 *
 * The REAL route, usecases and repositories (stock_transfer_out, sto_check,
 * outlet) run over two fake mysql pools - the GoFrugal one holding the STO
 * header/detail views and the app one holding sto_check and outlets. The
 * fakes answer the SQL they are sent from in-memory tables (applying the
 * WHERE the SQL asked for, never more), and record every query, so these
 * tests can see what reached the database:
 *
 *   THE RANGE IS SQL.       from_date / to_date become a half-open range on
 *                           the bare date column in the header query, not a
 *                           Node filter over every header.
 *   is_checked IS EARLY.    Unchecked STOs never get detail lines or branch
 *                           lookups; with no date range the header query
 *                           itself is limited to checked references.
 *   NO N+1.                 Headers, sto_check, detail lines, outlets: four
 *                           queries for 1 STO or 300.
 *   THE CALENDAR IS SMALL.  Two queries, per-day counts, no detail lines,
 *                           month boundaries exact, the day never moved by a
 *                           time zone.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const buildStoRepo = require("../repository/stock_transfer_out");
const buildStoCheckRepo = require("../repository/sto_check");
const buildOutletRepo = require("../repository/outlet");
const buildStoUsecase = require("./stock_transfer_out");
const buildStoCheckUsecase = require("./sto_check");
const buildOutletUsecase = require("./outlet");

const HDR = "medishopdb_Vw_StockTransferOut_hdr";
const DTL = "medishopdb_Vw_StockTransferOut_dtl";

/* ------------------------------------------------------------------ fakes */

function inList(sql, column) {
  return new RegExp(`${column} IN \\(`).test(sql);
}

/**
 * GoFrugal pool over `{ hdr, dtl }`. Dates are 'YYYY-MM-DD HH:mm:ss' strings,
 * compared as MySQL compares a DATETIME with a 'YYYY-MM-DD' literal.
 */
function fakeGofrugal(tables) {
  const queries = [];
  return {
    queries,
    query(sql, params, cb) {
      queries.push({ sql, params: [...params] });
      const p = [...params];
      if (sql.includes(DTL)) {
        let rows = tables.dtl;
        if (inList(sql, "Dn_no")) {
          const set = new Set(p.map(String));
          rows = rows.filter((r) => set.has(String(r.Dn_no)));
        } else if (/Dn_no = \?/.test(sql)) {
          rows = rows.filter((r) => String(r.Dn_no) === String(p[0]));
        }
        return cb(null, rows.map((r) => ({ ...r })));
      }
      if (sql.includes(HDR)) {
        let rows = tables.hdr;
        if (/`Dn_Date` >= \?/.test(sql)) {
          const from = p.shift();
          rows = rows.filter((r) => r.DN_date >= from);
        }
        if (/`Dn_Date` < \?/.test(sql)) {
          const toExcl = p.shift();
          rows = rows.filter((r) => r.DN_date < toExcl);
        }
        if (inList(sql, "Dn_Ref_no")) {
          const set = new Set(p.map(String));
          rows = rows.filter((r) => set.has(String(r.Dn_Ref_no)));
        } else if (/Dn_Ref_no = \?/.test(sql)) {
          rows = rows.filter((r) => String(r.Dn_Ref_no) === String(p[0]));
        } else if (/Dn_no = \?/.test(sql)) {
          rows = rows.filter((r) => String(r.Dn_no) === String(p[0]));
        }
        if (sql.includes("DATE_FORMAT")) {
          return cb(null, rows.map((r) => ({ date: r.DN_date.slice(0, 10), Dn_Ref_no: r.Dn_Ref_no })));
        }
        rows = [...rows].sort((a, b) => b.Dn_no - a.Dn_no);
        return cb(null, rows.map((r) => ({ ...r })));
      }
      return cb(new Error(`unexpected gofrugal SQL: ${sql}`));
    },
  };
}

/** MySQL's comparisons: INT against '00123' is numeric; a _ci VARCHAR ignores case and trailing spaces. */
const asInt = (v) => String(Number(v));
const asCiVarchar = (v) => String(v).replace(/ +$/, "").toLowerCase();

/** App pool over `{ stoCheck, outlets }`. */
function fakeApp(tables) {
  const queries = [];
  return {
    queries,
    query(sql, params, cb) {
      queries.push({ sql, params: [...params] });
      if (sql.includes("sto_check")) {
        let rows = tables.stoCheck;
        if (inList(sql, "dn_ref_no")) {
          const set = new Set(params.map(asInt));
          rows = rows.filter((r) => set.has(asInt(r.dn_ref_no)));
        } else if (/dn_ref_no = \?/.test(sql)) {
          rows = rows.filter((r) => String(r.dn_ref_no) === String(params[0]));
        }
        if (sql.includes("DISTINCT")) {
          return cb(null, [...new Set(rows.map((r) => r.dn_ref_no))].map((dn_ref_no) => ({ dn_ref_no })));
        }
        return cb(null, rows.map((r) => ({ ...r, de_name: `P${r.product_id}`, de_display_name: null })));
      }
      if (sql.includes("FROM outlets")) {
        let rows = tables.outlets;
        if (inList(sql, "gofrugal_id")) {
          const set = new Set(params.map(asCiVarchar));
          rows = rows.filter((r) => set.has(asCiVarchar(r.gofrugal_id)));
        } else if (/gofrugal_id = \?/.test(sql)) {
          rows = rows.filter((r) => String(r.gofrugal_id) === String(params[0]));
        }
        return cb(null, rows.map((r) => ({ ...r })));
      }
      return cb(new Error(`unexpected app SQL: ${sql}`));
    },
  };
}

/**
 * `n` STOs on `day` (plus optional extras), 3 lines each, every other one
 * checked, spread over 5 branches.
 */
function dataset({ n = 0, day = "2026-09-15", hdr = [], checkedEvery = 2 } = {}) {
  const tables = { hdr: [...hdr], dtl: [], stoCheck: [], outlets: [] };
  for (let b = 1; b <= 5; b++) {
    tables.outlets.push({ outlet_id: b, outlet_name: `Branch ${b}`, gofrugal_id: String(100 + b) });
  }
  for (let i = 1; i <= n; i++) {
    tables.hdr.push({
      Dn_no: i,
      Dn_Ref_no: 5000 + i,
      DN_date: `${day} 10:00:00`,
      Cust_Code: 101 + (i % 5),
      Cust_Name: `Branch ${1 + (i % 5)}`,
      Tot_Items: 3,
    });
  }
  tables.hdr.forEach((h) => {
    for (let s = 1; s <= 3; s++) {
      tables.dtl.push({ Dn_no: h.Dn_no, Dn_sl_no: s, Item_Code: 900 + s, Item_qty: s * 2 });
    }
  });
  tables.hdr.forEach((h, idx) => {
    if (checkedEvery && idx % checkedEvery === 0 && h.Dn_Ref_no != null) {
      tables.stoCheck.push({ dn_ref_no: h.Dn_Ref_no, product_id: 901, file_qty: 2 });
      tables.stoCheck.push({ dn_ref_no: h.Dn_Ref_no, product_id: 902, file_qty: 3 });
    }
  });
  return tables;
}

function wire(tables) {
  const gofrugal = fakeGofrugal(tables);
  const app = fakeApp(tables);
  const outletUsecase = buildOutletUsecase(buildOutletRepo(app));
  const stoCheckUsecase = buildStoCheckUsecase(buildStoCheckRepo(app));
  const usecase = buildStoUsecase(buildStoRepo(gofrugal), outletUsecase, stoCheckUsecase);
  const all = () => [...gofrugal.queries, ...app.queries];
  return { usecase, gofrugal, app, all };
}

/** The real router on an ephemeral port. */
async function serve(usecase) {
  delete require.cache[require.resolve("../routes/stock_transfer_out")];
  const buildRoutes = require("../routes/stock_transfer_out");
  const app = express();
  app.use("/stock-transfer-out", buildRoutes(usecase).getRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/stock-transfer-out`;
  return {
    get: async (path) => {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const hdrQueries = (q) => q.filter((x) => x.sql.includes(HDR));
const dtlQueries = (q) => q.filter((x) => x.sql.includes(DTL));

/* ------------------------------------------------------------------ tests */

describe("1. the date range is applied in the header SQL", () => {
  it("as a half-open range on the bare column, with no unfiltered read", async () => {
    const tables = dataset({
      hdr: [
        { Dn_no: 1, Dn_Ref_no: 11, DN_date: "2026-08-31 23:59:59", Cust_Code: 101 },
        { Dn_no: 2, Dn_Ref_no: 12, DN_date: "2026-09-01 00:00:00", Cust_Code: 101 },
        { Dn_no: 3, Dn_Ref_no: 13, DN_date: "2026-09-30 23:59:59", Cust_Code: 102 },
        { Dn_no: 4, Dn_Ref_no: 14, DN_date: "2026-10-01 00:00:00", Cust_Code: 102 },
      ],
    });
    const { usecase, gofrugal } = wire(tables);
    const list = await usecase.get({ from_date: "2026-09-01", to_date: "2026-09-30" });

    const [hdr] = hdrQueries(gofrugal.queries);
    assert.match(hdr.sql, /WHERE `Dn_Date` >= \? AND `Dn_Date` < \?/);
    assert.doesNotMatch(hdr.sql, /DATE\(`Dn_Date`\)/, "a DATE() wrapper would stop index use");
    assert.deepEqual(hdr.params, ["2026-09-01", "2026-10-01"]);
    assert.equal(hdrQueries(gofrugal.queries).length, 1);

    for (const q of dtlQueries(gofrugal.queries)) {
      assert.match(q.sql, /WHERE Dn_no IN \(/, "detail lines are never read unfiltered");
      assert.deepEqual(q.params.map(Number).sort(), [2, 3]);
    }
    assert.deepEqual(list.map((h) => h.Dn_no).sort(), [2, 3]);
  });

  it("the route rejects malformed and impossible dates before any query", async () => {
    const { usecase, all } = wire(dataset());
    const srv = await serve(usecase);
    try {
      for (const q of ["from_date=2026-9-1", "from_date=2026-02-31", "to_date=2026-13-01", "from_date=2026-09-10&to_date=2026-09-01"]) {
        const res = await srv.get(`/?${q}`);
        assert.equal(res.status, 400, q);
      }
      assert.equal(all().length, 0);
      const ok = await srv.get("/?from_date=2028-02-29&to_date=2028-02-29");
      assert.equal(ok.status, 200);
    } finally {
      await srv.close();
    }
  });
});

describe("2. is_checked=true does not load or enrich unchecked history", () => {
  it("without a range: the header query is restricted to checked references", async () => {
    const tables = dataset({ n: 40, checkedEvery: 4 }); // 10 checked of 40
    const { usecase, gofrugal, app } = wire(tables);
    const list = await usecase.get({ is_checked: true });

    assert.equal(list.length, 10);
    assert.ok(list.every((h) => h.is_checked === true));
    assert.match(app.queries[0].sql, /SELECT DISTINCT dn_ref_no FROM `sto_check`/);
    const [hdr] = hdrQueries(gofrugal.queries);
    assert.match(hdr.sql, /Dn_Ref_no IN \(/);
    assert.equal(hdr.params.length, 10, "only the checked references reach the header query");
    const [dtl] = dtlQueries(gofrugal.queries);
    assert.equal(dtl.params.length, 10, "no detail lines for unchecked STOs");
  });

  it("with a range: detail lines and branches only for the checked STOs", async () => {
    const tables = dataset({ n: 40, checkedEvery: 4 });
    const { usecase, gofrugal, app } = wire(tables);
    const list = await usecase.get({ is_checked: true, from_date: "2026-09-15", to_date: "2026-09-15" });

    assert.equal(list.length, 10);
    const [dtl] = dtlQueries(gofrugal.queries);
    assert.deepEqual(
      dtl.params.map(Number).sort((a, b) => a - b),
      list.map((h) => h.Dn_no).sort((a, b) => a - b)
    );
    const outletQ = app.queries.filter((q) => q.sql.includes("FROM outlets"));
    assert.equal(outletQ.length, 1);
  });

  it("no checked STO at all: nothing beyond the sto_check read", async () => {
    const { usecase, gofrugal } = wire(dataset({ n: 5, checkedEvery: 0 }));
    assert.deepEqual(await usecase.get({ is_checked: true }), []);
    assert.equal(gofrugal.queries.length, 0);
  });
});

describe("all mode (no is_checked)", () => {
  it("returns checked and unchecked STOs, each flagged, newest first", async () => {
    const { usecase } = wire(dataset({ n: 4 })); // Dn_no 1 and 3 checked
    const list = await usecase.get({ from_date: "2026-09-15", to_date: "2026-09-15" });
    assert.deepEqual(
      list.map((h) => [h.Dn_no, h.is_checked, h.file_items.length, h.items.length]),
      [[4, false, 0, 3], [3, true, 2, 3], [2, false, 0, 3], [1, true, 2, 3]]
    );
  });
});

describe("3/4. branch and sto_check enrichment are batched", () => {
  it("one outlet query over the distinct Cust_Codes, one sto_check query over the refs", async () => {
    const { usecase, app } = wire(dataset({ n: 25 }));
    const list = await usecase.get({ from_date: "2026-09-15", to_date: "2026-09-15" });

    const outletQ = app.queries.filter((q) => q.sql.includes("FROM outlets"));
    assert.equal(outletQ.length, 1);
    assert.match(outletQ[0].sql, /gofrugal_id IN \(/);
    assert.deepEqual([...outletQ[0].params].sort(), ["101", "102", "103", "104", "105"]);

    const checkQ = app.queries.filter((q) => q.sql.includes("sto_check"));
    assert.equal(checkQ.length, 1);
    assert.match(checkQ[0].sql, /dn_ref_no IN \(/);
    assert.equal(checkQ[0].params.length, 25);

    for (const h of list) {
      assert.equal(h.branch.gofrugal_id, String(h.Cust_Code));
    }
  });

  it("the batched join matches what the per-STO SQL matched ('05001' = 5001, 'AB1 ' = 'ab1')", async () => {
    const tables = dataset({
      hdr: [{ Dn_no: 1, Dn_Ref_no: "05001", DN_date: "2026-09-15 09:00:00", Cust_Code: "AB1 " }],
      checkedEvery: 0,
    });
    tables.stoCheck.push({ dn_ref_no: 5001, product_id: 901, file_qty: 4 });
    tables.outlets.push({ outlet_id: 9, outlet_name: "Alpha", gofrugal_id: "ab1" });
    const { usecase } = wire(tables);
    const [h] = await usecase.get({ from_date: "2026-09-15", to_date: "2026-09-15" });
    assert.equal(h.is_checked, true);
    assert.equal(h.items.find((i) => i.Item_Code === 901).file_qty, 4);
    assert.equal(h.branch.outlet_name, "Alpha");
    assert.deepEqual(await usecase.getCalendar(2026, 9), [
      { date: "2026-09-15", total: 1, checked: 1, unchecked: 0 },
    ]);
  });

  it("a Cust_Code with no outlet, or none at all, gets branch null", async () => {
    const tables = dataset({
      hdr: [
        { Dn_no: 1, Dn_Ref_no: 11, DN_date: "2026-09-15 09:00:00", Cust_Code: 999 },
        { Dn_no: 2, Dn_Ref_no: null, DN_date: "2026-09-15 09:00:00", Cust_Code: null },
      ],
    });
    const { usecase } = wire(tables);
    const list = await usecase.get({ from_date: "2026-09-15", to_date: "2026-09-15" });
    assert.deepEqual(list.map((h) => h.branch), [null, null]);
    const noRef = list.find((h) => h.Dn_no === 2);
    assert.equal(noRef.is_checked, false);
    assert.deepEqual(noRef.file_items, []);
  });
});

describe("5/6/7. zero, one and many STOs", () => {
  it("zero STOs: an empty list after the one header query", async () => {
    const { usecase, all } = wire(dataset());
    assert.deepEqual(await usecase.get({ from_date: "2026-09-01", to_date: "2026-09-30" }), []);
    assert.equal(all().length, 1);
  });

  it("one STO: the full listing shape", async () => {
    const { usecase } = wire(dataset({ n: 1 }));
    const [h] = await usecase.get({ from_date: "2026-09-15", to_date: "2026-09-15" });
    assert.equal(h.Dn_no, 1);
    assert.equal(h.Cust_Name, "Branch 2");
    assert.equal(h.branch.outlet_name, "Branch 2");
    assert.equal(h.is_checked, true);
    assert.deepEqual(
      h.file_items.map((f) => [f.product_id, f.file_qty]),
      [[901, 2], [902, 3]]
    );
    assert.deepEqual(
      h.items.map((i) => [i.Item_Code, i.Item_qty, i.file_qty]),
      [[901, 2, 2], [902, 4, 3], [903, 6, null]]
    );
  });

  it("query count does not grow with the number of STOs", async () => {
    const counts = {};
    for (const n of [1, 10, 300]) {
      const { usecase, all } = wire(dataset({ n }));
      const list = await usecase.get({ from_date: "2026-09-01", to_date: "2026-09-30" });
      assert.equal(list.length, n);
      counts[n] = all().length;
    }
    assert.deepEqual(counts, { 1: 4, 10: 4, 300: 4 });
  });

  it("past the IN chunk size it grows by one query per 1000, not per STO", async () => {
    const { usecase, all } = wire(dataset({ n: 1500 }));
    const list = await usecase.get({ from_date: "2026-09-15", to_date: "2026-09-15" });
    assert.equal(list.length, 1500);
    // headers 1 + sto_check 2 chunks + detail 2 chunks + outlets 1
    assert.equal(all().length, 6);
  });
});

describe("8. detailed endpoints still return item details", () => {
  it("GET /:Dn_no (View) and GET /by-ref/:Dn_Ref_no (Edit/View) carry items, file_qty and branch", async () => {
    const { usecase } = wire(dataset({ n: 3 }));
    const srv = await serve(usecase);
    try {
      const one = await srv.get("/1");
      assert.equal(one.status, 200);
      assert.equal(one.body.data.items.length, 3);
      assert.equal(one.body.data.items[0].file_qty, 2);
      assert.equal(one.body.data.branch.outlet_name, "Branch 2");
      assert.equal(one.body.data.is_checked, true);

      const byRef = await srv.get("/by-ref/5002");
      assert.equal(byRef.status, 200);
      assert.equal(byRef.body.data.length, 1);
      assert.equal(byRef.body.data[0].items.length, 3);
      assert.equal(byRef.body.data[0].is_checked, false);
      assert.ok(byRef.body.data[0].items.every((i) => i.file_qty === null));

      assert.equal((await srv.get("/424242")).status, 404);
    } finally {
      await srv.close();
    }
  });

  it("GET / with a range (Create's last-7-days list) still carries items", async () => {
    const { usecase } = wire(dataset({ n: 4 }));
    const srv = await serve(usecase);
    try {
      const res = await srv.get("/?from_date=2026-09-09&to_date=2026-09-15");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 4);
      assert.ok(res.body.data.every((h) => h.items.length === 3));
    } finally {
      await srv.close();
    }
  });
});

describe("9. calendar month boundaries", () => {
  let srv;
  let ctx;
  before(async () => {
    const tables = dataset({
      hdr: [
        { Dn_no: 1, Dn_Ref_no: 11, DN_date: "2028-01-31 23:59:59", Cust_Code: 101 },
        { Dn_no: 2, Dn_Ref_no: 12, DN_date: "2028-02-01 00:00:00", Cust_Code: 101 },
        { Dn_no: 3, Dn_Ref_no: 13, DN_date: "2028-02-29 23:59:59", Cust_Code: 101 },
        { Dn_no: 4, Dn_Ref_no: 14, DN_date: "2028-02-29 08:00:00", Cust_Code: 101 },
        { Dn_no: 5, Dn_Ref_no: null, DN_date: "2028-02-29 09:00:00", Cust_Code: 101 },
        { Dn_no: 6, Dn_Ref_no: 16, DN_date: "2028-03-01 00:00:00", Cust_Code: 101 },
      ],
      checkedEvery: 2, // Dn_no 1, 3, 5(no ref) -> refs 11 and 13 checked
    });
    ctx = wire(tables);
    srv = await serve(ctx.usecase);
  });
  after(() => srv.close());

  it("February of a leap year: first and last instants in, neighbours out", async () => {
    const res = await srv.get("/calendar?year=2028&month=2");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, [
      { date: "2028-02-01", total: 1, checked: 0, unchecked: 1 },
      { date: "2028-02-29", total: 3, checked: 1, unchecked: 2 },
    ]);
    const [hdr] = hdrQueries(ctx.gofrugal.queries);
    assert.deepEqual(hdr.params, ["2028-02-01", "2028-03-01"]);
    assert.match(hdr.sql, /DATE_FORMAT/);
  });

  it("is two queries and never reads detail lines", async () => {
    ctx.gofrugal.queries.length = 0;
    ctx.app.queries.length = 0;
    await srv.get("/calendar?year=2028&month=2");
    assert.equal(ctx.gofrugal.queries.length + ctx.app.queries.length, 2);
    assert.equal(dtlQueries(ctx.gofrugal.queries).length, 0);
    assert.doesNotMatch(ctx.app.queries[0].sql, /product_table/);
  });

  it("year boundary: Dec 31 23:59:59 is December, Jan 1 00:00:00 is January", async () => {
    const tables = dataset({
      hdr: [
        { Dn_no: 1, Dn_Ref_no: 11, DN_date: "2026-11-30 23:59:59", Cust_Code: 101 },
        { Dn_no: 2, Dn_Ref_no: 12, DN_date: "2026-12-31 23:59:59", Cust_Code: 101 },
        { Dn_no: 3, Dn_Ref_no: 13, DN_date: "2027-01-01 00:00:00", Cust_Code: 101 },
      ],
      checkedEvery: 0,
    });
    const { usecase } = wire(tables);
    assert.deepEqual(await usecase.getCalendar(2026, 12), [
      { date: "2026-12-31", total: 1, checked: 0, unchecked: 1 },
    ]);
    assert.deepEqual(await usecase.getCalendar(2027, 1), [
      { date: "2027-01-01", total: 1, checked: 0, unchecked: 1 },
    ]);
    const day = await usecase.get({ from_date: "2026-12-31", to_date: "2026-12-31" });
    assert.deepEqual(day.map((h) => h.Dn_no), [2]);
  });

  it("December rolls into the next year", async () => {
    ctx.gofrugal.queries.length = 0;
    await srv.get("/calendar?year=2026&month=12");
    assert.deepEqual(hdrQueries(ctx.gofrugal.queries)[0].params, ["2026-12-01", "2027-01-01"]);
  });

  it("an empty month is an empty list; bad year/month is a 400 (not caught by /:Dn_no)", async () => {
    assert.deepEqual((await srv.get("/calendar?year=2027&month=6")).body.data, []);
    for (const q of ["", "?year=2026", "?year=2026&month=0", "?year=2026&month=13", "?year=abc&month=9"]) {
      const res = await srv.get(`/calendar${q}`);
      assert.equal(res.status, 400, q);
      assert.match(res.body.msg, /year|month/);
    }
  });
});

describe("10. the STO's day is the stored calendar day (Asia/Kolkata)", () => {
  it("the range bounds are plain dates, not instants shifted by the process time zone", () => {
    const { nextDay } = buildStoRepo;
    const saved = process.env.TZ;
    try {
      for (const tz of ["Asia/Kolkata", "UTC", "America/Los_Angeles"]) {
        process.env.TZ = tz;
        assert.equal(nextDay("2026-09-30"), "2026-10-01", tz);
        assert.equal(nextDay("2028-02-28"), "2028-02-29", tz);
        assert.equal(nextDay("2026-12-31"), "2027-01-01", tz);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("an STO just after IST midnight is on its own day, one just before on the previous", async () => {
    const tables = dataset({
      hdr: [
        { Dn_no: 1, Dn_Ref_no: 11, DN_date: "2026-08-31 23:50:00", Cust_Code: 101 },
        { Dn_no: 2, Dn_Ref_no: 12, DN_date: "2026-09-01 00:15:00", Cust_Code: 101 },
        { Dn_no: 3, Dn_Ref_no: 13, DN_date: "2026-09-01 05:29:00", Cust_Code: 101 },
      ],
    });
    const { usecase } = wire(tables);
    const cal = await usecase.getCalendar(2026, 9);
    assert.deepEqual(cal.map((d) => [d.date, d.total]), [["2026-09-01", 2]]);
    const day = await usecase.get({ from_date: "2026-09-01", to_date: "2026-09-01" });
    assert.deepEqual(day.map((h) => h.Dn_no).sort(), [2, 3]);
  });
});
