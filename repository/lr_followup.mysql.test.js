/**
 * LR FOLLOW-UP, AS REAL SQL - the migrations, both triggers, every
 * mutation, the backfill, and what happens when they race.
 *
 *   LR_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/lr_followup.mysql.test.js
 *
 * SKIPPED unless `LR_TEST_MYSQL` names a SCRATCH database: the suite drops
 * and creates its tables. The Transporter Master and LR Follow-up MIGRATION
 * FILES THEMSELVES are run, on top of the Advance Request tables as the
 * stage-4 migration leaves them, so what is tested is what production runs.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.LR_TEST_MYSQL;

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const sqlFile = (name) => fs.readFileSync(path.join(SQLS, name), "utf8");

const BASE_SCHEMA = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS lr_followup_activity, lr_followup, credit_purchases,
    transporter_master_audit, transporter_master, advance_request_activity,
    advance_request_documents, advance_requests, product_distributor_master,
    people_list, outlets, new_employee, all_permissions, permissions;
  SET FOREIGN_KEY_CHECKS = 1;
  CREATE TABLE product_distributor_master (mdm_dist_code INT PRIMARY KEY, mdm_dist_name VARCHAR(100), cid VARCHAR(20)) ENGINE=InnoDB;
  CREATE TABLE people_list (person_id INT PRIMARY KEY, name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL) ENGINE=InnoDB;
  CREATE TABLE all_permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100));
  CREATE TABLE permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100), designation_id INT, is_active TINYINT(1) DEFAULT 1);
  INSERT INTO product_distributor_master VALUES (10, 'Sri Balaji Traders', 'C10'), (11, 'Kaveri Foods', 'C11');
  INSERT INTO outlets VALUES (1, 'Anna Nagar'), (2, 'Velachery');
  INSERT INTO new_employee VALUES (501, 'Purchase Lead', 1), (502, 'Accounts', 1), (503, 'Store Keeper', 2);
`;

const EMP = 501;
const ACCOUNTS = 502;

/** A clock the tests can move. Starts on 1 October 2026, 10:00 IST. */
function makeClock() {
  let now = new Date("2026-10-01T04:30:00Z");
  const clock = () => new Date(now.getTime());
  clock.set = (iso) => {
    now = new Date(iso);
  };
  clock.addDays = (n) => {
    now = new Date(now.getTime() + n * 86400000);
  };
  return clock;
}

describe("LR Follow-up, as SQL", { skip: !URL && "LR_TEST_MYSQL is not set" }, () => {
  let pool;
  let q;
  let clock;
  let advanceRepo;
  let advance;
  let lrRepo;
  let lr;
  let transporters;
  let credit;
  let transporterId;

  before(async () => {
    pool = require("mysql").createPool(
      `${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=12&multipleStatements=true`
    );
    q = (sql, params = []) =>
      new Promise((resolve, reject) => pool.query(sql, params, (err, res) => (err ? reject(err) : resolve(res))));
  });

  after(async () => {
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    await q(BASE_SCHEMA);
    await q(sqlFile("20260903020000-lr-workflow-stage-4-up.sql"));
    await q(sqlFile("20261109110000-transporter-master-up.sql"));
    await q(sqlFile("20261109120000-lr-followup-up.sql"));

    clock = makeClock();
    advanceRepo = require("./advance_request")(pool);
    lrRepo = require("./lr_followup")(pool);
    transporters = require("../usecase/transporter_master")(require("./transporter_master")(pool));
    lr = require("../usecase/lr_followup")(lrRepo, transporters, { clock });
    advance = require("../usecase/advance_request")(advanceRepo, { lrFollowup: lr });
    credit = require("../usecase/credit_purchase")(require("./credit_purchase")(pool), lr, transporters, { clock });

    const t = await transporters.create({ transporter_name: "VRL Logistics", contact_no: "98765 43210" }, EMP);
    transporterId = t.transporter_id;
  });

  /** Raises an advance and walks it to `approved` through the real workflow. */
  async function approvedAdvance({ outlet = 1, amount = 5000 } = {}) {
    const id = await advance.create({
      invoice_number: "PI-77",
      distributor_code: 10,
      amount,
      reason: null,
      outlet_id: outlet,
      created_by: EMP,
    });
    await advance.balanceCheck(id, { previous_advance_balance: 0 }, ACCOUNTS);
    await advance.approval(id, { decision: "approve" }, EMP);
    return id;
  }

  async function paidAdvance(opts) {
    const id = await approvedAdvance(opts);
    await advance.payment(id, {}, ACCOUNTS);
    return id;
  }

  const followupsFor = (advanceId) => q("SELECT * FROM lr_followup WHERE advance_request_id = ?", [advanceId]);
  const history = (id) =>
    q("SELECT * FROM lr_followup_activity WHERE lr_followup_id = ? ORDER BY lr_followup_activity_id", [id]);

  function creditInput(extra = {}) {
    return {
      distributor_code: 11,
      bill_reference: "KF/2026/101",
      amount: 12500,
      bill_date: "2026-09-29",
      outlet_id: 1,
      transporter_id: transporterId,
      ...extra,
    };
  }

  // ------------------------------------------------------------ advance trigger

  describe("Advance Request -> paid", () => {
    it("1. a paid advance creates exactly one follow-up, Dispatch / LR Pending, ageing from paid_at", async () => {
      const id = await paidAdvance();
      const rows = await followupsFor(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "DISPATCH_PENDING");
      assert.equal(rows[0].source_type, "ADVANCE_REQUEST");
      assert.equal(Number(rows[0].amount), 5000);
      assert.equal(rows[0].invoice_number, "PI-77");

      const [ar] = await q("SELECT paid_at FROM advance_requests WHERE advance_request_id = ?", [id]);
      assert.equal(new Date(rows[0].source_date).getTime(), new Date(ar.paid_at).getTime());

      const h = await history(rows[0].lr_followup_id);
      assert.equal(h.length, 1);
      assert.equal(h[0].activity_type, "CREATED");
      assert.match(h[0].remark, /Advance payment completed/);
    });

    it("2. re-processing the same paid event does not create a second follow-up", async () => {
      const id = await paidAdvance();
      const again = await lr.createForPaidAdvance(id, ACCOUNTS);
      assert.equal(again.created, false);
      // Five at once, each in its own transaction.
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => lr.createForPaidAdvance(id, ACCOUNTS)));
      assert.ok(results.every((r) => r.created === false));
      assert.equal((await followupsFor(id)).length, 1);
      // And the payment step itself cannot run twice.
      await assert.rejects(advance.payment(id, {}, ACCOUNTS), (e) => e.name === "ConflictError");
      assert.equal((await followupsFor(id)).length, 1);
    });

    it("two simultaneous payments: one wins, one 409s, one follow-up", async () => {
      const id = await approvedAdvance();
      const outcomes = await Promise.allSettled([advance.payment(id, {}, ACCOUNTS), advance.payment(id, {}, ACCOUNTS)]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      assert.equal(outcomes.find((o) => o.status === "rejected").reason.name, "ConflictError");
      assert.equal((await followupsFor(id)).length, 1);
    });

    it("the payment and the follow-up are one transaction: a failed follow-up leaves the advance approved", async () => {
      const id = await approvedAdvance();
      const failing = require("../usecase/advance_request")(advanceRepo, {
        lrFollowup: { createForPaidAdvance: () => Promise.reject(new Error("boom")) },
      });
      await assert.rejects(failing.payment(id, {}, ACCOUNTS), /boom/);
      const [ar] = await q("SELECT status, paid_at FROM advance_requests WHERE advance_request_id = ?", [id]);
      assert.equal(ar.status, "approved");
      assert.equal(ar.paid_at, null);
      const acts = await q("SELECT * FROM advance_request_activity WHERE advance_request_id = ? AND new_value = 'paid'", [id]);
      assert.equal(acts.length, 0);
    });

    it("19. the Advance Request workflow itself is unchanged: same statuses, same history", async () => {
      const id = await paidAdvance();
      const [ar] = await q("SELECT status FROM advance_requests WHERE advance_request_id = ?", [id]);
      assert.equal(ar.status, "paid");
      const acts = await q(
        "SELECT old_value, new_value FROM advance_request_activity WHERE advance_request_id = ? ORDER BY activity_id",
        [id]
      );
      assert.deepEqual(
        acts.map((a) => `${a.old_value}->${a.new_value}`),
        ["null->submitted", "submitted->pending_approval", "pending_approval->approved", "approved->paid"]
      );
      // Rejected and held advances never open a follow-up.
      const rejected = await advance.create({ distributor_code: 10, amount: 10, created_by: EMP });
      await advance.balanceCheck(rejected, { previous_advance_balance: 0 }, ACCOUNTS);
      await advance.approval(rejected, { decision: "reject" }, EMP);
      assert.equal((await followupsFor(rejected)).length, 0);
    });
  });

  // ------------------------------------------------------------ credit trigger

  describe("Credit Purchase -> created", () => {
    it("3. creating a credit purchase creates exactly one follow-up, carrying the transporter", async () => {
      const cp = await credit.create(creditInput(), EMP, null);
      const rows = await q("SELECT * FROM lr_followup WHERE credit_purchase_id = ?", [cp.credit_purchase_id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source_type, "CREDIT_PURCHASE");
      assert.equal(Number(rows[0].transporter_id), transporterId);
      assert.equal(rows[0].invoice_number, "KF/2026/101");
      assert.equal(cp.lr_followup_id, rows[0].lr_followup_id);
      assert.equal(cp.transporter_name, "VRL Logistics");
    });

    it("4. a repeated credit purchase event does not create another follow-up", async () => {
      const key = "c0ffee00-0000-4000-8000-000000000001";
      const results = await Promise.all([1, 2, 3].map(() => credit.create(creditInput({ request_key: key }), EMP, null)));
      assert.equal(new Set(results.map((r) => r.credit_purchase_id)).size, 1);
      assert.equal((await q("SELECT * FROM credit_purchases")).length, 1);
      assert.equal((await q("SELECT * FROM lr_followup")).length, 1);

      const again = await lr.createForCreditPurchase(results[0].credit_purchase_id, EMP);
      assert.equal(again.created, false);

      // The same supplier bill under a new key is a duplicate purchase.
      await assert.rejects(
        credit.create(creditInput({ request_key: "another" }), EMP, null),
        (e) => e.name === "ConflictError" && /already entered/.test(e.message)
      );
    });

    it("5. a new follow-up begins in Dispatch / LR Pending - the transporter alone is not dispatch", async () => {
      const cp = await credit.create(creditInput(), EMP, null);
      const [f] = await q("SELECT status FROM lr_followup WHERE credit_purchase_id = ?", [cp.credit_purchase_id]);
      assert.equal(f.status, "DISPATCH_PENDING");
    });

    it("a credit purchase entered with an LR number starts In Transit", async () => {
      const cp = await credit.create(creditInput({ lr_no: "LR-786542", dispatch_date: "2026-09-30" }), EMP, null);
      const [f] = await q("SELECT status, lr_no FROM lr_followup WHERE credit_purchase_id = ?", [cp.credit_purchase_id]);
      assert.equal(f.status, "IN_TRANSIT");
      assert.equal(f.lr_no, "LR-786542");
    });

    it("an inactive transporter cannot be chosen for a new credit purchase", async () => {
      await transporters.update(transporterId, { is_active: false }, EMP);
      await assert.rejects(credit.create(creditInput(), EMP, null), (e) => /inactive/.test(e.message));
      assert.equal((await q("SELECT * FROM credit_purchases")).length, 0);
    });

    it("an Own Store user cannot raise a purchase for another branch", async () => {
      await assert.rejects(credit.create(creditInput({ outlet_id: 1 }), EMP, [2]), (e) => e.name === "ForbiddenError");
    });
  });

  // ------------------------------------------------------------ mutations

  describe("updating a follow-up", () => {
    let fid;
    beforeEach(async () => {
      const id = await paidAdvance();
      fid = (await followupsFor(id))[0].lr_followup_id;
    });

    it("6. an LR update moves Dispatch / LR Pending to In Transit", async () => {
      const d = await lr.updateLr(fid, { lr_no: "LR-786542", transporter_id: transporterId }, EMP, null);
      assert.equal(d.status, "IN_TRANSIT");
      assert.equal(d.transporter_name, "VRL Logistics");
      const h = await history(fid);
      const update = h.find((a) => a.activity_type === "LR_UPDATE");
      assert.equal(update.old_status, "DISPATCH_PENDING");
      assert.equal(update.new_status, "IN_TRANSIT");
    });

    it("7. the LR number can stay empty - a dispatch date is enough", async () => {
      const d = await lr.updateLr(fid, { dispatch_date: "2026-09-30" }, EMP, null);
      assert.equal(d.status, "IN_TRANSIT");
      assert.equal(d.lr_no, null);
      // Transporter only: still pending.
      const id2 = await paidAdvance();
      const f2 = (await followupsFor(id2))[0].lr_followup_id;
      const d2 = await lr.updateLr(f2, { transporter_id: transporterId }, EMP, null);
      assert.equal(d2.status, "DISPATCH_PENDING");
    });

    it("clearing the dispatch details puts it back to Dispatch / LR Pending", async () => {
      await lr.updateLr(fid, { lr_no: "LR-1" }, EMP, null);
      const d = await lr.updateLr(fid, { lr_no: "" }, EMP, null);
      assert.equal(d.status, "DISPATCH_PENDING");
    });

    it("a dispatch date in the future is refused", async () => {
      await assert.rejects(lr.updateLr(fid, { dispatch_date: "2026-10-05" }, EMP, null), (e) => e.name === "BusinessRuleError");
    });

    it("8 and 9. Add Follow-up appends an immutable history row and updates the next follow-up date", async () => {
      await lr.addFollowUp(fid, { remark: "Supplier contacted. Dispatch expected tonight.", next_follow_up_date: "2026-10-02" }, EMP, null);
      const d = await lr.addFollowUp(fid, { remark: "Called again.", next_follow_up_date: "2026-10-03" }, EMP, null);
      const rows = (await history(fid)).filter((a) => a.activity_type === "FOLLOW_UP");
      assert.deepEqual(rows.map((r) => r.remark), ["Supplier contacted. Dispatch expected tonight.", "Called again."]);
      assert.equal(d.latest_remark, "Called again.");
      assert.equal(d.next_follow_up_date && String(require("../utils/lr_followup").toDateOnly(d.next_follow_up_date)), "2026-10-03");
    });

    it("a retried submission (same request key) writes one history row", async () => {
      const body = { remark: "Spoke to dispatch desk", request_key: "k-1" };
      await Promise.all([lr.addFollowUp(fid, body, EMP, null), lr.addFollowUp(fid, body, EMP, null)]);
      await lr.addFollowUp(fid, body, EMP, null);
      const rows = (await history(fid)).filter((a) => a.activity_type === "FOLLOW_UP");
      assert.equal(rows.length, 1);
    });

    it("changing the expected delivery date is recorded on its own", async () => {
      await lr.addFollowUp(fid, { remark: "New ETA", expected_delivery_date: "2026-10-04" }, EMP, null);
      const h = await history(fid);
      assert.ok(h.some((a) => a.activity_type === "EXPECTED_DELIVERY_CHANGE"));
    });

    it("10. expected delivery passing today makes it Overdue - derived, not stored", async () => {
      await lr.updateLr(fid, { expected_delivery_date: "2026-10-03" }, EMP, null);
      let list = await lr.list({ overdue_only: true }, null, 50, 0);
      assert.equal(list.count, 0);

      clock.set("2026-10-03T04:30:00Z"); // due today: not yet overdue
      list = await lr.list({ overdue_only: true }, null, 50, 0);
      assert.equal(list.count, 0);

      clock.set("2026-10-05T04:30:00Z");
      list = await lr.list({ overdue_only: true }, null, 50, 0);
      assert.equal(list.count, 1);
      assert.equal(list.items[0].is_overdue, true);
      assert.equal(list.items[0].days_overdue, 2);
      const summary = await lr.summary(null);
      assert.equal(summary.overdue, 1);
      const [stored] = await q("SELECT status FROM lr_followup WHERE lr_followup_id = ?", [fid]);
      assert.equal(stored.status, "DISPATCH_PENDING");
    });

    it("11. Mark Goods Received closes the follow-up, recording who, when and both steps", async () => {
      const d = await lr.markGoodsReceived(fid, { remark: "All 40 cartons" }, EMP, null);
      assert.equal(d.status, "CLOSED");
      assert.equal(d.closure_reason, "GOODS_RECEIVED");
      assert.equal(Number(d.goods_received_by), EMP);
      assert.ok(d.goods_received_at);
      assert.ok(d.closed_at);
      const h = await history(fid);
      assert.deepEqual(
        h.slice(-2).map((a) => `${a.activity_type}:${a.old_status}->${a.new_status}`),
        ["GOODS_RECEIVED:DISPATCH_PENDING->GOODS_RECEIVED", "CLOSED:GOODS_RECEIVED->CLOSED"]
      );
    });

    it("12. a closed follow-up cannot be received or closed again - not even by two clicks at once", async () => {
      const outcomes = await Promise.allSettled([
        lr.markGoodsReceived(fid, {}, EMP, null),
        lr.markGoodsReceived(fid, {}, EMP, null),
      ]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      assert.equal(outcomes.find((o) => o.status === "rejected").reason.name, "ConflictError");
      await assert.rejects(lr.markGoodsReceived(fid, {}, EMP, null), (e) => e.name === "ConflictError");
      await assert.rejects(lr.addFollowUp(fid, { remark: "x" }, EMP, null), (e) => e.name === "ConflictError");
      const closes = (await history(fid)).filter((a) => a.activity_type === "CLOSED");
      assert.equal(closes.length, 1);
    });

    it("LR entered, dispatch reported and expected date passed - still open until receipt", async () => {
      await lr.updateLr(fid, { lr_no: "LR-9", dispatch_date: "2026-09-30", expected_delivery_date: "2026-09-30" }, EMP, null);
      clock.addDays(10);
      const d = await lr.getDetail(fid, null);
      assert.equal(d.status, "IN_TRANSIT");
      assert.equal(d.closed_at, null);
    });

    it("an inactive transporter stays on the record, and cannot be newly selected", async () => {
      await lr.updateLr(fid, { transporter_id: transporterId }, EMP, null);
      await transporters.update(transporterId, { is_active: false }, EMP);
      const d = await lr.updateLr(fid, { lr_no: "LR-2" }, EMP, null);
      assert.equal(d.transporter_name, "VRL Logistics");
      assert.equal(d.transporter_is_active, false);
      const other = await paidAdvance();
      const f2 = (await followupsFor(other))[0].lr_followup_id;
      await assert.rejects(lr.updateLr(f2, { transporter_id: transporterId }, EMP, null), (e) => /inactive/.test(e.message));
    });
  });

  // ------------------------------------------------------------ backfill

  describe("go-live backfill", () => {
    /** A paid advance from before the module: no follow-up, as production holds them. */
    async function legacyPaid(paidAt) {
      const res = await q(
        `INSERT INTO advance_requests (distributor_code, amount, outlet_id, status, created_by, paid_by, paid_at)
         VALUES (10, 7000, 1, 'paid', ?, ?, ?)`,
        [EMP, ACCOUNTS, paidAt]
      );
      return res.insertId;
    }

    it("13. every paid advance without a follow-up comes in as Verification Required, keeping paid_at", async () => {
      const a = await legacyPaid("2026-08-01 11:00:00");
      const b = await legacyPaid("2026-09-20 16:30:00");
      const live = await paidAdvance(); // already has one

      const run = await lr.backfill(EMP);
      assert.equal(run.created, 2);

      for (const [id, paidAt] of [[a, "2026-08-01 11:00:00"], [b, "2026-09-20 16:30:00"]]) {
        const [f] = await followupsFor(id);
        assert.equal(f.status, "VERIFICATION_REQUIRED");
        assert.equal(f.is_legacy, 1);
        const [ar] = await q("SELECT paid_at FROM advance_requests WHERE advance_request_id = ?", [id]);
        assert.equal(new Date(f.source_date).getTime(), new Date(ar.paid_at).getTime());
        assert.equal(paidAt.length > 0, true);
        const [h] = await history(f.lr_followup_id);
        assert.equal(h.activity_type, "BACKFILL");
        assert.match(h.remark, /cannot be determined automatically/);
      }
      assert.equal((await followupsFor(live)).length, 1);
    });

    it("14. the backfill is idempotent - run again, or twice at once, it creates nothing new", async () => {
      await legacyPaid("2026-08-01 11:00:00");
      await legacyPaid("2026-08-02 11:00:00");
      const [r1, r2] = await Promise.all([lr.backfill(EMP), lr.backfill(EMP)]);
      assert.equal(r1.created + r2.created, 2);
      const r3 = await lr.backfill(EMP);
      assert.equal(r3.created, 0);
      assert.equal((await q("SELECT * FROM lr_followup")).length, 2);
      assert.equal((await q("SELECT * FROM lr_followup_activity WHERE activity_type = 'BACKFILL'")).length, 2);
    });

    it("15 and 16. uncertain legacy rows wait for a decision and never count as active", async () => {
      const a = await legacyPaid("2026-08-01 11:00:00");
      const b = await legacyPaid("2026-08-05 11:00:00");
      await lr.backfill(EMP);
      const fa = (await followupsFor(a))[0].lr_followup_id;
      const fb = (await followupsFor(b))[0].lr_followup_id;

      let summary = await lr.summary(null);
      assert.equal(summary.total_open, 0);
      assert.equal(summary.verification_required, 2);
      assert.equal((await lr.list({}, null, 50, 0)).count, 0);
      assert.equal(summary.missing_advance_followups, 0);

      // Mark Goods Received is not the legacy path.
      await assert.rejects(lr.markGoodsReceived(fa, {}, EMP, null), (e) => e.name === "ConflictError");

      await lr.resolve(fa, { decision: "GOODS_RECEIVED", remark: "GRN checked: arrived 3 Aug", received_at: "2026-08-03T10:00:00+05:30" }, EMP, null);
      const da = await lr.getDetail(fa, null);
      assert.equal(da.status, "CLOSED");
      assert.equal(da.closure_reason, "GOODS_RECEIVED");

      await lr.resolve(fb, { decision: "STILL_PENDING", remark: "Supplier yet to dispatch" }, EMP, null);
      summary = await lr.summary(null);
      assert.equal(summary.total_open, 1);
      assert.equal(summary.verification_required, 0);

      // A decided row cannot be decided again; every decision is in the history.
      await assert.rejects(lr.resolve(fa, { decision: "REFUNDED", remark: "x" }, EMP, null), (e) => e.name === "ConflictError");
      const decisions = await q("SELECT * FROM lr_followup_activity WHERE activity_type = 'VERIFICATION_DECISION'");
      assert.equal(decisions.length, 2);

      // The original advance requests are untouched.
      const ars = await q("SELECT status FROM advance_requests WHERE advance_request_id IN (?, ?)", [a, b]);
      assert.ok(ars.every((r) => r.status === "paid"));
    });

    it("a paid advance missing its follow-up is reported, not hidden", async () => {
      const a = await legacyPaid("2026-08-01 11:00:00");
      const card = await lr.getBySource("ADVANCE_REQUEST", a, null);
      assert.equal(card.expected, true);
      assert.equal(card.followup, null);
      assert.match(card.exception, /should have an LR Follow-up/);
      assert.equal((await lr.summary(null)).missing_advance_followups, 1);
    });
  });

  // ------------------------------------------------------------ scope

  describe("branch scope", () => {
    it("18. a follow-up of another branch reads as not found, and is left out of lists", async () => {
      const id = await paidAdvance({ outlet: 1 });
      const fid = (await followupsFor(id))[0].lr_followup_id;
      await assert.rejects(lr.getDetail(fid, [2]), (e) => e.name === "NotFoundError");
      await assert.rejects(lr.markGoodsReceived(fid, {}, EMP, [2]), (e) => e.name === "NotFoundError");
      await assert.rejects(lr.getBySource("ADVANCE_REQUEST", id, [2]), (e) => e.name === "ForbiddenError");
      assert.equal((await lr.list({}, [2], 50, 0)).count, 0);
      assert.equal((await lr.list({}, [1], 50, 0)).count, 1);
      assert.equal((await lr.summary([2])).total_open, 0);
      const [f] = await followupsFor(id);
      assert.equal(f.status, "DISPATCH_PENDING");
    });
  });

  // ------------------------------------------------------------ dashboard

  describe("the dashboard", () => {
    it("filters by source, ageing bucket and supplier, oldest and most overdue first", async () => {
      const a = await paidAdvance(); // paid 1 Oct
      await credit.create(creditInput({ bill_date: "2026-09-20" }), EMP, null); // 11 days
      const fa = (await followupsFor(a))[0].lr_followup_id;
      await lr.updateLr(fa, { expected_delivery_date: "2026-09-30" }, EMP, null); // overdue

      const all = await lr.list({}, null, 50, 0);
      assert.equal(all.count, 2);
      assert.equal(all.items[0].lr_followup_id, fa); // overdue first
      const credits = await lr.list({ source_type: "CREDIT_PURCHASE" }, null, 50, 0);
      assert.equal(credits.count, 1);
      assert.equal(credits.items[0].ageing_days, 11);
      assert.equal(credits.items[0].ageing_bucket, "10+");
      const old = await lr.list({ ageing_min: 11 }, null, 50, 0);
      assert.equal(old.count, 1);
      const bySupplier = await lr.list({ distributor_code: 10 }, null, 50, 0);
      assert.equal(bySupplier.count, 1);

      const s = await lr.summary(null);
      assert.deepEqual(
        { open: s.total_open, adv: s.advance_open, cred: s.credit_open, pending: s.dispatch_pending, overdue: s.overdue },
        { open: 2, adv: 1, cred: 1, pending: 2, overdue: 1 }
      );
      assert.equal(s.outstanding_amount, 17500);
    });
  });

  // ------------------------------------------------------------ transporter master

  describe("Transporter Master", () => {
    it("protects names against duplicates, ignoring case and spacing", async () => {
      await assert.rejects(
        transporters.create({ transporter_name: "  vrl   LOGISTICS ", contact_no: "9123456789" }, EMP),
        (e) => e.name === "ConflictError"
      );
      const results = await Promise.allSettled(
        [1, 2].map(() => transporters.create({ transporter_name: "KPN Parcel", contact_no: "9123456789" }, EMP))
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    });

    it("validates contact numbers", async () => {
      await assert.rejects(
        transporters.create({ transporter_name: "ABC", contact_no: "12345" }, EMP),
        (e) => e.name === "BusinessRuleError"
      );
      const t = await transporters.create({ transporter_name: "ABC", contact_no: "044-2345 6789" }, EMP);
      assert.equal(t.contact_no, "04423456789");
    });

    it("audits create and every changed field; inactive leaves the dropdown but not old records", async () => {
      await transporters.update(transporterId, { contact_person: "Ravi", is_active: false }, EMP);
      const t = await transporters.getById(transporterId);
      const fields = t.audit.map((a) => `${a.action}:${a.field}`).sort();
      assert.ok(fields.includes("CREATE:transporter_name"));
      assert.ok(fields.includes("UPDATE:contact_person"));
      assert.ok(fields.includes("UPDATE:is_active"));
      assert.equal(Number(t.updated_by), EMP);
      assert.equal((await transporters.options()).length, 0);
    });

    it("a referenced transporter cannot be hard-deleted", async () => {
      await credit.create(creditInput(), EMP, null);
      await assert.rejects(q("DELETE FROM transporter_master WHERE transporter_id = ?", [transporterId]), /foreign key/i);
    });
  });

  // ------------------------------------------------------------ audit safety

  describe("audit safety", () => {
    it("history cannot be orphaned: a follow-up with history cannot be deleted", async () => {
      const id = await paidAdvance();
      await assert.rejects(q("DELETE FROM lr_followup WHERE advance_request_id = ?", [id]), /foreign key/i);
    });
  });
});
