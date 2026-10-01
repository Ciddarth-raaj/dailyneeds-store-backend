const { istDateOf } = require("../utils/istDate");
const {
  SOURCE_TYPE,
  STATUS,
  CLOSURE_REASON,
  ACTIVITY,
  DECISION,
  NON_RECEIPT_DECISIONS,
  conflict,
  notFound,
  invalid,
  isTerminal,
  statusForDispatch,
  toDateOnly,
  decorate,
  followupRef,
  outcomeForDecision,
  ageingBucket,
  daysBetween,
} = require("../utils/lr_followup");

/**
 * LR Follow-up: from "paid for / bought on credit" to "goods physically
 * received".
 *
 * TWO TRIGGERS, ONE SHAPE. `createForPaidAdvance` runs inside the Advance
 * Request payment's own transaction; `createForCreditPurchase` inside the
 * Credit Purchase insert's. Both lock the source row first and then look for
 * an existing follow-up with a locking read, so the same event processed
 * twice - a retry, a double click, two servers - finds the first follow-up
 * instead of making a second. The unique keys on the table are the backstop.
 *
 * EVERY MUTATION locks the follow-up row, re-checks its status under the
 * lock, writes the row and its history in one transaction, and honours the
 * client's `request_key`: a submission already recorded is answered with the
 * current state and writes nothing.
 *
 * ONE CLOSING RULE. Only Mark Goods Received closes a live follow-up in the
 * normal course. Refunded / adjusted / cancelled is a separate, audited
 * decision reserved to `manage_lr_legacy_verification`.
 */

const isDuplicateKey = (err) => err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);

const forbidden = (message) => {
  const err = new Error(message);
  err.name = "ForbiddenError";
  return err;
};

const STATUS_LABEL = {
  DISPATCH_PENDING: "Dispatch / LR Pending",
  IN_TRANSIT: "In Transit",
  GOODS_RECEIVED: "Goods Received",
  CLOSED: "Closed",
  VERIFICATION_REQUIRED: "Verification Required",
};

const DECISION_LABEL = {
  GOODS_RECEIVED: "Goods received",
  STILL_PENDING: "Goods still pending",
  REFUNDED: "Refunded",
  ADJUSTED: "Adjusted / settled",
  CANCELLED: "Cancelled",
};

const fmtDate = (value) => {
  const d = toDateOnly(value);
  if (!d) return null;
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

/** The LR fields a dispatch update may carry. */
const LR_FIELDS = ["lr_no", "transporter_id", "dispatch_date", "expected_delivery_date"];

const clean = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
};

const same = (a, b) => {
  const norm = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  return norm(a) === norm(b);
};

class LrFollowupUsecase {
  /**
   * @param repo         repository/lr_followup
   * @param transporters usecase/transporter_master (assertSelectable)
   * @param clock        () => Date, injectable for tests
   */
  constructor(repo, transporters, { clock = () => new Date() } = {}) {
    this.repo = repo;
    this.transporters = transporters;
    this.clock = clock;
  }

  now() {
    return this.clock();
  }

  today() {
    return istDateOf(this.now());
  }

  /** Adds the refs, the ageing bucket and the boolean overdue flag. */
  present(row) {
    if (!row) return row;
    const today = this.today();
    const base = decorate(row, today);
    // The SQL figures are authoritative for list rows (they are what the
    // filters and sorting used); recomputed ones fill in otherwise.
    const ageing = row.ageing_days !== undefined && row.ageing_days !== null
      ? Number(row.ageing_days)
      : base.ageing_days;
    return {
      ...base,
      ageing_days: ageing,
      ageing_bucket: ageingBucket(ageing),
      is_overdue: row.is_overdue !== undefined ? Boolean(Number(row.is_overdue)) : base.is_overdue,
      days_overdue: row.days_overdue !== undefined ? Number(row.days_overdue) : undefined,
      status_label: STATUS_LABEL[row.status] || row.status,
      transporter_is_active:
        row.transporter_is_active === undefined || row.transporter_is_active === null
          ? null
          : Boolean(Number(row.transporter_is_active)),
    };
  }

  inScope(row, storeIds) {
    if (storeIds === null || storeIds === undefined) return true;
    return row.outlet_id !== null && row.outlet_id !== undefined && storeIds.includes(Number(row.outlet_id));
  }

  // =================================================================
  // Triggers
  // =================================================================

  /**
   * The Advance Request payment trigger. Called with the payment's
   * transaction connection, after the status has been written to `paid`.
   * Without a connection it opens its own transaction (the backfill path
   * and tests).
   *
   * @returns {{ created: boolean, lr_followup_id: number }}
   */
  async createForPaidAdvance(advanceRequestId, actorId = null, conn = null) {
    if (!conn) {
      return this.repo.transaction((c) => this.createForPaidAdvance(advanceRequestId, actorId, c));
    }

    // Lock the source first: every path that creates a follow-up for this
    // advance queues here, so the check below cannot race.
    const advance = await this.repo.getAdvanceRequest(advanceRequestId, conn, { forUpdate: true });
    if (!advance) throw notFound("Advance request not found");
    if (advance.status !== "paid") {
      throw conflict(`Advance request AR-${advanceRequestId} is ${advance.status}, not paid.`);
    }

    const existing = await this.repo.getBySource(SOURCE_TYPE.ADVANCE_REQUEST, advanceRequestId, null, conn, {
      forUpdate: true,
    });
    if (existing) return { created: false, lr_followup_id: Number(existing.lr_followup_id) };

    const sourceDate = advance.paid_at || this.now();
    return this.insertWithHistory(
      {
        source_type: SOURCE_TYPE.ADVANCE_REQUEST,
        advance_request_id: advanceRequestId,
        distributor_code: advance.distributor_code,
        outlet_id: advance.outlet_id ?? null,
        amount: advance.paid_amount ?? advance.amount,
        source_date: sourceDate,
        invoice_number: advance.invoice_number ?? null,
        status: STATUS.DISPATCH_PENDING,
        created_by: actorId,
      },
      {
        activity_type: ACTIVITY.CREATED,
        remark: `Advance payment completed (AR-${advanceRequestId}). Follow-up opened: waiting for dispatch / LR.`,
        new_status: STATUS.DISPATCH_PENDING,
        created_by: actorId,
      },
      conn,
      () => this.repo.getBySource(SOURCE_TYPE.ADVANCE_REQUEST, advanceRequestId, null, conn, { forUpdate: true })
    );
  }

  /**
   * The Credit Purchase trigger, inside the purchase insert's transaction.
   * The purchase's own dispatch details are copied in, so a purchase that
   * already has an LR or dispatch date starts In Transit.
   */
  async createForCreditPurchase(creditPurchaseId, actorId = null, conn = null) {
    if (!conn) {
      return this.repo.transaction((c) => this.createForCreditPurchase(creditPurchaseId, actorId, c));
    }

    const purchase = await this.repo.getCreditPurchase(creditPurchaseId, conn, { forUpdate: true });
    if (!purchase) throw notFound("Credit purchase not found");

    const existing = await this.repo.getBySource(SOURCE_TYPE.CREDIT_PURCHASE, creditPurchaseId, null, conn, {
      forUpdate: true,
    });
    if (existing) return { created: false, lr_followup_id: Number(existing.lr_followup_id) };

    const tracking = {
      lr_no: purchase.lr_no ?? null,
      transporter_id: purchase.transporter_id ?? null,
      dispatch_date: purchase.dispatch_date ?? null,
      expected_delivery_date: purchase.expected_delivery_date ?? null,
    };
    const status = statusForDispatch(STATUS.DISPATCH_PENDING, tracking);

    return this.insertWithHistory(
      {
        source_type: SOURCE_TYPE.CREDIT_PURCHASE,
        credit_purchase_id: creditPurchaseId,
        distributor_code: purchase.distributor_code,
        outlet_id: purchase.outlet_id ?? null,
        amount: purchase.amount,
        source_date: toDateOnly(purchase.bill_date) || this.today(),
        invoice_number: purchase.bill_reference ?? null,
        ...tracking,
        status,
        created_by: actorId,
      },
      {
        activity_type: ACTIVITY.CREATED,
        remark:
          status === STATUS.IN_TRANSIT
            ? `Credit purchase CP-${creditPurchaseId} created with dispatch details. Follow-up opened: in transit.`
            : `Credit purchase CP-${creditPurchaseId} created. Follow-up opened: waiting for dispatch / LR.`,
        new_status: status,
        details: { tracking },
        created_by: actorId,
      },
      conn,
      () => this.repo.getBySource(SOURCE_TYPE.CREDIT_PURCHASE, creditPurchaseId, null, conn, { forUpdate: true })
    );
  }

  /** Insert + first history row; a duplicate key answers with the winner. */
  async insertWithHistory(row, activity, conn, findExisting) {
    let id;
    try {
      id = await this.repo.insert(row, conn);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const winner = await findExisting();
      if (!winner) throw err;
      return { created: false, lr_followup_id: Number(winner.lr_followup_id) };
    }
    await this.repo.insertActivity({ ...activity, lr_followup_id: id }, conn);
    return { created: true, lr_followup_id: Number(id) };
  }

  // =================================================================
  // Reads
  // =================================================================

  async list(filters, storeIds, limit, offset, sortBy, sortDir) {
    const today = this.today();
    const [rows, count] = await Promise.all([
      this.repo.list(filters, storeIds, today, limit, offset, sortBy, sortDir),
      this.repo.count(filters, storeIds, today),
    ]);
    return { items: rows.map((r) => this.present(r)), count, limit, offset };
  }

  async summary(storeIds) {
    const [cards, missingAdvances] = await Promise.all([
      this.repo.summary(storeIds, this.today()),
      this.repo.paidAdvancesWithoutFollowup(storeIds),
    ]);
    return { ...cards, missing_advance_followups: missingAdvances.length };
  }

  async getDetail(id, storeIds) {
    const row = await this.repo.getById(id, this.today());
    // Out of scope reads exactly like missing: knowing an id is not access.
    if (!row || !this.inScope(row, storeIds)) throw notFound("Follow-up not found");

    const [activity, source] = await Promise.all([this.repo.getActivity(id), this.sourceOf(row)]);
    return { ...this.present(row), activity, source };
  }

  async sourceOf(row) {
    if (row.source_type === SOURCE_TYPE.ADVANCE_REQUEST) {
      const a = await this.repo.getAdvanceRequest(row.advance_request_id);
      return a && {
        type: SOURCE_TYPE.ADVANCE_REQUEST,
        id: Number(a.advance_request_id),
        ref: `AR-${a.advance_request_id}`,
        status: a.status,
        amount: a.amount,
        invoice_number: a.invoice_number,
        paid_at: a.paid_at,
        paid_by_name: a.paid_by_name,
        created_at: a.created_at,
      };
    }
    const p = await this.repo.getCreditPurchase(row.credit_purchase_id);
    return p && {
      type: SOURCE_TYPE.CREDIT_PURCHASE,
      id: Number(p.credit_purchase_id),
      ref: `CP-${p.credit_purchase_id}`,
      amount: p.amount,
      bill_reference: p.bill_reference,
      bill_date: p.bill_date,
      transporter_name: p.transporter_name,
      transporter_contact_no: p.transporter_contact_no,
      remarks: p.remarks,
      created_by_name: p.created_by_name,
      created_at: p.created_at,
    };
  }

  /**
   * The follow-up for one source, for the read-only card on the Advance
   * Request and Credit Purchase screens.
   *
   * `expected` says whether one SHOULD exist, so a paid advance with no
   * follow-up is reported as an exception rather than shown as nothing.
   */
  async getBySource(sourceType, sourceId, storeIds) {
    let expected = false;
    if (sourceType === SOURCE_TYPE.ADVANCE_REQUEST) {
      const advance = await this.repo.getAdvanceRequest(sourceId);
      if (!advance) throw notFound("Advance request not found");
      expected = advance.status === "paid";
    } else {
      const purchase = await this.repo.getCreditPurchase(sourceId);
      if (!purchase) throw notFound("Credit purchase not found");
      expected = true;
    }

    const row = await this.repo.getBySource(sourceType, sourceId, this.today());
    if (row && !this.inScope(row, storeIds)) {
      throw forbidden("This follow-up belongs to a branch outside your scope.");
    }

    return {
      expected,
      followup: row ? this.present(row) : null,
      exception:
        expected && !row
          ? "This source should have an LR Follow-up but none exists. Run the backfill on the Legacy Follow-up Verification screen, or report it to the administrator."
          : null,
    };
  }

  // =================================================================
  // Mutations
  // =================================================================

  /**
   * Locks the follow-up, checks scope and replay, runs `work`, returns the
   * fresh detail. `work` gets (row, conn, now).
   */
  async mutate(id, storeIds, requestKey, work) {
    await this.repo.transaction(async (conn) => {
      const row = await this.repo.getById(id, null, conn, { forUpdate: true });
      if (!row || !this.inScope(row, storeIds)) throw notFound("Follow-up not found");

      if (requestKey) {
        const done = await this.repo.findActivityByRequestKey(id, requestKey, conn);
        if (done) return; // already recorded: answer with the current state
      }

      await work(row, conn, this.now());
    });
    return this.getDetail(id, storeIds);
  }

  assertLive(row, action) {
    if (isTerminal(row.status)) {
      throw conflict(`${followupRef(row.lr_followup_id)} is already closed; ${action} is not possible.`);
    }
    if (row.status === STATUS.VERIFICATION_REQUIRED) {
      throw conflict(
        `${followupRef(row.lr_followup_id)} is waiting for legacy verification. Record the verification decision first.`
      );
    }
  }

  assertDates({ dispatch_date, next_follow_up_date }) {
    const today = this.today();
    if (dispatch_date && toDateOnly(dispatch_date) > today) {
      throw invalid("Dispatch Date cannot be in the future.");
    }
    if (next_follow_up_date && toDateOnly(next_follow_up_date) < today) {
      throw invalid("Next Follow-up Date cannot be in the past.");
    }
  }

  /**
   * Update LR / dispatch details. Every field is optional; a field left out
   * is unchanged, a field sent empty is cleared. An LR number or dispatch
   * date moves a pending follow-up to In Transit.
   */
  async updateLr(id, data, actorId, storeIds) {
    const input = {};
    LR_FIELDS.forEach((f) => {
      if (data[f] !== undefined) input[f] = f === "transporter_id" ? data[f] ?? null : clean(data[f]);
    });
    const remark = clean(data.remark);
    this.assertDates(input);

    return this.mutate(id, storeIds, data.request_key, async (row, conn, now) => {
      this.assertLive(row, "updating LR details");

      if (input.transporter_id !== undefined && input.transporter_id !== null) {
        await this.transporters.assertSelectable(input.transporter_id, row.transporter_id, conn);
      }

      const changes = {};
      Object.keys(input).forEach((f) => {
        const before = f.endsWith("_date") ? toDateOnly(row[f]) : row[f];
        if (!same(before, input[f])) changes[f] = { from: before ?? null, to: input[f] ?? null };
      });

      if (Object.keys(changes).length === 0 && !remark) {
        throw invalid("Nothing to update: change an LR field or add a remark.");
      }

      const after = { ...row };
      Object.keys(changes).forEach((f) => {
        after[f] = changes[f].to;
      });
      const nextStatus = statusForDispatch(row.status, after);

      const fields = {};
      Object.keys(changes).forEach((f) => {
        fields[f] = changes[f].to;
      });
      if (nextStatus !== row.status) fields.status = nextStatus;
      if (remark) {
        fields.latest_remark = remark;
        fields.last_follow_up_at = now;
      }

      await this.repo.update(id, row.status, fields, conn);

      await this.repo.insertActivity(
        {
          lr_followup_id: id,
          activity_type: ACTIVITY.LR_UPDATE,
          remark: remark || this.describeLrChange(changes),
          old_status: nextStatus !== row.status ? row.status : null,
          new_status: nextStatus !== row.status ? nextStatus : null,
          details: { changes },
          request_key: data.request_key ?? null,
          created_by: actorId,
        },
        conn
      );

      if (changes.expected_delivery_date) {
        await this.repo.insertActivity(
          {
            lr_followup_id: id,
            activity_type: ACTIVITY.EXPECTED_DELIVERY_CHANGE,
            remark: `Expected delivery ${fmtDate(changes.expected_delivery_date.from) || "not set"} → ${
              fmtDate(changes.expected_delivery_date.to) || "not set"
            }.`,
            details: { expected_delivery_date: changes.expected_delivery_date },
            created_by: actorId,
          },
          conn
        );
      }
    });
  }

  describeLrChange(changes) {
    const parts = [];
    if (changes.lr_no) parts.push(changes.lr_no.to ? `LR received: ${changes.lr_no.to}` : "LR No. cleared");
    if (changes.transporter_id) parts.push("Transporter updated");
    if (changes.dispatch_date) {
      parts.push(
        changes.dispatch_date.to ? `Dispatched on ${fmtDate(changes.dispatch_date.to)}` : "Dispatch date cleared"
      );
    }
    if (changes.expected_delivery_date) parts.push("Expected delivery updated");
    return parts.length ? `${parts.join(". ")}.` : "LR details updated.";
  }

  /** Add Follow-up: a remark, always a new history row; never overwrites. */
  async addFollowUp(id, data, actorId, storeIds) {
    const remark = clean(data.remark);
    if (!remark) throw invalid("Remark is required.");
    const nextDate = data.next_follow_up_date === undefined ? undefined : clean(data.next_follow_up_date);
    const expected = data.expected_delivery_date === undefined ? undefined : clean(data.expected_delivery_date);
    this.assertDates({ next_follow_up_date: nextDate });

    return this.mutate(id, storeIds, data.request_key, async (row, conn, now) => {
      this.assertLive(row, "adding a follow-up");

      const fields = { latest_remark: remark, last_follow_up_at: now };
      if (nextDate !== undefined) fields.next_follow_up_date = nextDate;

      const expectedBefore = toDateOnly(row.expected_delivery_date);
      const expectedChanged = expected !== undefined && !same(expectedBefore, expected);
      if (expectedChanged) fields.expected_delivery_date = expected;

      await this.repo.update(id, row.status, fields, conn);
      await this.repo.insertActivity(
        {
          lr_followup_id: id,
          activity_type: ACTIVITY.FOLLOW_UP,
          remark,
          next_follow_up_date: nextDate ?? null,
          request_key: data.request_key ?? null,
          created_by: actorId,
        },
        conn
      );
      if (expectedChanged) {
        await this.repo.insertActivity(
          {
            lr_followup_id: id,
            activity_type: ACTIVITY.EXPECTED_DELIVERY_CHANGE,
            remark: `Expected delivery ${fmtDate(expectedBefore) || "not set"} → ${fmtDate(expected) || "not set"}.`,
            details: { expected_delivery_date: { from: expectedBefore, to: expected } },
            created_by: actorId,
          },
          conn
        );
      }
    });
  }

  parseReceivedAt(value, now) {
    if (value === undefined || value === null || value === "") return now;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw invalid("Received date/time is not a valid date.");
    // A few minutes of clock skew between browser and server is not fraud.
    if (at.getTime() > now.getTime() + 5 * 60 * 1000) {
      throw invalid("Received date/time cannot be in the future.");
    }
    return at;
  }

  /**
   * Mark Goods Received - the one normal closing action. Records the
   * receipt and closes in the same transaction; history shows both steps.
   */
  async markGoodsReceived(id, data, actorId, storeIds) {
    const remark = clean(data.remark);
    const now = this.now();
    const receivedAt = this.parseReceivedAt(data.received_at, now);

    return this.mutate(id, storeIds, data.request_key, async (row, conn, at) => {
      this.assertLive(row, "marking goods received");

      const affected = await this.repo.update(
        id,
        row.status,
        {
          status: STATUS.CLOSED,
          closure_reason: CLOSURE_REASON.GOODS_RECEIVED,
          goods_received_at: receivedAt,
          goods_received_by: actorId,
          closed_at: at,
          closed_by: actorId,
          next_follow_up_date: null,
        },
        conn
      );
      if (affected === 0) throw conflict("This follow-up changed while you were working on it. Reload it.");

      await this.repo.insertActivity(
        {
          lr_followup_id: id,
          activity_type: ACTIVITY.GOODS_RECEIVED,
          remark: remark ? `Goods physically received. ${remark}` : "Goods physically received.",
          old_status: row.status,
          new_status: STATUS.GOODS_RECEIVED,
          details: { received_at: receivedAt.toISOString() },
          request_key: data.request_key ?? null,
          created_by: actorId,
        },
        conn
      );
      await this.repo.insertActivity(
        {
          lr_followup_id: id,
          activity_type: ACTIVITY.CLOSED,
          remark: "Follow-up automatically closed on goods receipt.",
          old_status: STATUS.GOODS_RECEIVED,
          new_status: STATUS.CLOSED,
          created_by: actorId,
        },
        conn
      );
    });
  }

  /**
   * A recorded decision, for two cases:
   *
   *   * a VERIFICATION_REQUIRED (legacy) follow-up: any of the five answers;
   *   * a live follow-up whose goods will never come: refunded, adjusted or
   *     cancelled only - received goes through Mark Goods Received.
   *
   * A remark is required for every decision; it is the audit's "why".
   */
  async resolve(id, data, actorId, storeIds) {
    const decision = data.decision;
    if (!DECISION[decision]) throw invalid(`Unknown decision: ${decision}`);
    const remark = clean(data.remark);
    if (!remark) throw invalid("A remark is required for every verification decision.");
    const now = this.now();
    const receivedAt =
      decision === DECISION.GOODS_RECEIVED && data.received_at
        ? this.parseReceivedAt(data.received_at, now)
        : null;

    return this.mutate(id, storeIds, data.request_key, async (row, conn, at) => {
      if (isTerminal(row.status)) {
        throw conflict(`${followupRef(row.lr_followup_id)} is already closed.`);
      }
      const legacy = row.status === STATUS.VERIFICATION_REQUIRED;
      if (!legacy && !NON_RECEIPT_DECISIONS.includes(decision)) {
        throw conflict(
          decision === DECISION.GOODS_RECEIVED
            ? "Use Mark Goods Received for a live follow-up."
            : "This follow-up is not waiting for verification."
        );
      }

      const outcome = outcomeForDecision(decision, row);
      const fields = { status: outcome.status };
      if (outcome.status === STATUS.CLOSED) {
        Object.assign(fields, {
          closure_reason: outcome.closure_reason,
          closed_at: at,
          closed_by: actorId,
          next_follow_up_date: null,
        });
        if (decision === DECISION.GOODS_RECEIVED) {
          fields.goods_received_at = receivedAt;
          fields.goods_received_by = actorId;
        }
      }
      fields.latest_remark = remark;
      fields.last_follow_up_at = at;

      const affected = await this.repo.update(id, row.status, fields, conn);
      if (affected === 0) throw conflict("This follow-up changed while you were working on it. Reload it.");

      await this.repo.insertActivity(
        {
          lr_followup_id: id,
          activity_type: legacy ? ACTIVITY.VERIFICATION_DECISION : ACTIVITY.CLOSED,
          remark: `${DECISION_LABEL[decision]}: ${remark}`,
          old_status: row.status,
          new_status: outcome.status,
          details: {
            decision,
            legacy,
            received_at: receivedAt ? receivedAt.toISOString() : null,
          },
          request_key: data.request_key ?? null,
          created_by: actorId,
        },
        conn
      );
      if (legacy && outcome.status === STATUS.CLOSED) {
        await this.repo.insertActivity(
          {
            lr_followup_id: id,
            activity_type: ACTIVITY.CLOSED,
            remark: `Closed on verification: ${DECISION_LABEL[decision].toLowerCase()}.`,
            old_status: STATUS.VERIFICATION_REQUIRED,
            new_status: STATUS.CLOSED,
            created_by: actorId,
          },
          conn
        );
      }
    });
  }

  // =================================================================
  // Go-live backfill
  // =================================================================

  /**
   * Brings every paid Advance Request (and, defensively, every Credit
   * Purchase) that has no follow-up into the module, as
   * VERIFICATION_REQUIRED.
   *
   * WHY NOT ASSUME. dnds has no internal goods-receipt record linked to an
   * advance request, so whether an old advance's goods arrived cannot be
   * proven from the data. Nothing is closed automatically and nothing is
   * assumed pending: each one waits for a person to say which.
   *
   * IDEMPOTENT. Each source is handled in its own transaction that locks
   * the source and re-checks for a follow-up; a second run, or two runs at
   * once, create nothing new.
   */
  async backfill(actorId) {
    const [advanceIds, creditIds] = await Promise.all([
      this.repo.paidAdvancesWithoutFollowup(null),
      this.repo.creditPurchasesWithoutFollowup(null),
    ]);
    const runAt = this.now();
    const results = [];

    for (const id of advanceIds) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.repo.transaction((conn) => this.backfillAdvance(id, actorId, runAt, conn)));
    }
    for (const id of creditIds) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.repo.transaction((conn) => this.backfillCredit(id, actorId, runAt, conn)));
    }

    return {
      examined: results.length,
      created: results.filter((r) => r.created).length,
      already_linked: results.filter((r) => !r.created).length,
      items: results,
    };
  }

  async backfillAdvance(id, actorId, runAt, conn) {
    const advance = await this.repo.getAdvanceRequest(id, conn, { forUpdate: true });
    if (!advance || advance.status !== "paid") {
      return { source_ref: `AR-${id}`, created: false, finding: "No longer a paid advance; skipped." };
    }
    const existing = await this.repo.getBySource(SOURCE_TYPE.ADVANCE_REQUEST, id, null, conn, { forUpdate: true });
    if (existing) {
      return { source_ref: `AR-${id}`, created: false, lr_followup_id: Number(existing.lr_followup_id) };
    }

    // paid_at is stamped by A3; payment_date / updated_at only stand in for
    // a row that somehow lacks it, and the finding says so.
    const sourceDate = advance.paid_at || advance.payment_date || advance.updated_at;
    const usedFallback = !advance.paid_at;
    const days = daysBetween(sourceDate, istDateOf(runAt));
    const finding =
      `Legacy paid advance, paid ${fmtDate(sourceDate) || "on an unknown date"}` +
      `${days !== null ? ` (${days} days before go-live)` : ""}. ` +
      "dnds holds no goods-receipt record linked to advance requests, so whether the goods arrived " +
      "cannot be determined automatically. Verify and record the outcome." +
      (usedFallback ? " paid_at was missing; ageing uses the payment record's other date." : "");

    const result = await this.insertWithHistory(
      {
        source_type: SOURCE_TYPE.ADVANCE_REQUEST,
        advance_request_id: id,
        distributor_code: advance.distributor_code,
        outlet_id: advance.outlet_id ?? null,
        amount: advance.paid_amount ?? advance.amount,
        source_date: sourceDate,
        invoice_number: advance.invoice_number ?? null,
        status: STATUS.VERIFICATION_REQUIRED,
        is_legacy: 1,
        latest_remark: finding,
        created_by: actorId,
      },
      {
        activity_type: ACTIVITY.BACKFILL,
        remark: finding,
        new_status: STATUS.VERIFICATION_REQUIRED,
        details: {
          backfill_run_at: runAt.toISOString(),
          source_ref: `AR-${id}`,
          paid_at: advance.paid_at ? new Date(advance.paid_at).toISOString() : null,
          receipt_evidence: null,
        },
        created_by: actorId,
      },
      conn,
      () => this.repo.getBySource(SOURCE_TYPE.ADVANCE_REQUEST, id, null, conn, { forUpdate: true })
    );
    return { source_ref: `AR-${id}`, finding, ...result };
  }

  async backfillCredit(id, actorId, runAt, conn) {
    const purchase = await this.repo.getCreditPurchase(id, conn, { forUpdate: true });
    if (!purchase) return { source_ref: `CP-${id}`, created: false, finding: "Purchase not found; skipped." };
    const existing = await this.repo.getBySource(SOURCE_TYPE.CREDIT_PURCHASE, id, null, conn, { forUpdate: true });
    if (existing) {
      return { source_ref: `CP-${id}`, created: false, lr_followup_id: Number(existing.lr_followup_id) };
    }

    const finding =
      `Credit purchase dated ${fmtDate(purchase.bill_date)} had no follow-up. ` +
      "Whether the goods arrived cannot be determined automatically. Verify and record the outcome.";
    const result = await this.insertWithHistory(
      {
        source_type: SOURCE_TYPE.CREDIT_PURCHASE,
        credit_purchase_id: id,
        distributor_code: purchase.distributor_code,
        outlet_id: purchase.outlet_id ?? null,
        amount: purchase.amount,
        source_date: toDateOnly(purchase.bill_date),
        invoice_number: purchase.bill_reference ?? null,
        lr_no: purchase.lr_no ?? null,
        transporter_id: purchase.transporter_id ?? null,
        dispatch_date: purchase.dispatch_date ?? null,
        expected_delivery_date: purchase.expected_delivery_date ?? null,
        status: STATUS.VERIFICATION_REQUIRED,
        is_legacy: 1,
        latest_remark: finding,
        created_by: actorId,
      },
      {
        activity_type: ACTIVITY.BACKFILL,
        remark: finding,
        new_status: STATUS.VERIFICATION_REQUIRED,
        details: { backfill_run_at: runAt.toISOString(), source_ref: `CP-${id}`, receipt_evidence: null },
        created_by: actorId,
      },
      conn,
      () => this.repo.getBySource(SOURCE_TYPE.CREDIT_PURCHASE, id, null, conn, { forUpdate: true })
    );
    return { source_ref: `CP-${id}`, finding, ...result };
  }

  /** The Legacy Follow-up Verification queue (and, optionally, its decided rows). */
  async legacyQueue(storeIds, { include_decided = false, limit = 200, offset = 0 } = {}) {
    const filters = include_decided ? { status: "ALL", is_legacy: true } : { status: STATUS.VERIFICATION_REQUIRED };
    const result = await this.list(filters, storeIds, limit, offset, "source_date", "asc");
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        receipt_evidence: "None recorded in dnds",
        system_finding:
          item.status === STATUS.VERIFICATION_REQUIRED
            ? "Receipt cannot be determined from dnds data - needs a decision."
            : `Decided: ${item.status_label}${item.closure_reason ? ` (${item.closure_reason})` : ""}`,
      })),
    };
  }
}

LrFollowupUsecase.STATUS_LABEL = STATUS_LABEL;

module.exports = (repo, transporters, options) => new LrFollowupUsecase(repo, transporters, options);
