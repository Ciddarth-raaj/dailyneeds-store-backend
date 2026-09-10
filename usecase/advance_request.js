/**
 * The advance request approval chain.
 *
 * Purchase raise it; accounts record what the supplier already holds; if
 * there is a balance the request goes back to purchase to decide whether
 * to less-and-pay or defer; the admin approves, holds or rejects; accounts
 * pay through Tally and file the advice, which closes it.
 *
 * Each stage may only act on the statuses the steps before it can leave
 * behind, so the rules live here rather than in the routes: the route says
 * who may call a stage, this says whether the request is in a state where
 * that stage means anything.
 */

/** Terminal statuses. Nothing moves a request out of these. */
const TERMINAL = ["rejected", "paid"];

/**
 * The statuses each stage may act on.
 *
 * More than one where a request can arrive at the same stage by different
 * routes: accounts run the balance check on a fresh request and re-run it on
 * one they are holding, and the A1 details stay correctable for as long as
 * nobody downstream has acted on them.
 */
const ACTS_ON = {
  balanceCheck: ["submitted"],
  balanceAction: ["pending_purchase_decision"],
  // The admin acts on a fresh request or on one they are already holding,
  // which is how a hold is released without a second trip through accounts.
  approval: ["pending_approval", "on_hold"],
  payment: ["approved"],
  edit: ["submitted", "pending_purchase_decision", "on_hold"],
};

/** What each of the admin's three decisions leaves the request as. */
const DECISION_STATUS = {
  approve: "approved",
  hold: "on_hold",
  reject: "rejected",
};

/**
 * A wrong-state transition is the caller's request being stale, not a server
 * fault, so it carries a name the route maps to 409 rather than 500.
 */
const conflict = (message) => {
  const err = new Error(message);
  err.name = "ConflictError";
  return err;
};

const notFound = (message) => {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
};

/** Reads a request or throws, so every stage starts the same way. */
const describeStatus = (status) => {
  if (TERMINAL.includes(status)) {
    return `This request is already ${status} and cannot be changed.`;
  }
  return `This request is ${status}.`;
};

class AdvanceRequestUsecase {
  constructor(advanceRequestRepo) {
    this.advanceRequestRepo = advanceRequestRepo;
  }

  async create(request) {
    const { id } = await this.advanceRequestRepo.create(request);
    await this.advanceRequestRepo.createActivity(
      id,
      request.created_by,
      "status",
      null,
      "submitted"
    );
    return id;
  }

  async getAll(filters, limit, offset, sortBy, sortDir) {
    const [items, count] = await Promise.all([
      this.advanceRequestRepo.getAll(filters, limit, offset, sortBy, sortDir),
      this.advanceRequestRepo.getCount(filters),
    ]);
    return { items, count, limit, offset };
  }

  async getById(id) {
    const request = await this.advanceRequestRepo.getById(id);
    if (!request) return null;

    const [documents, activity] = await Promise.all([
      this.advanceRequestRepo.getDocumentsByRequestId(id),
      this.advanceRequestRepo.getActivityByRequestId(id),
    ]);

    return { ...request, documents, activity };
  }

  /**
   * Moves a request from one status to the next, writing the stage's own
   * fields at the same time.
   *
   * The repository only updates rows still holding `expectedStatus`, so a
   * second caller racing the first changes nothing and is told why.
   */
  async applyStage(id, stage, nextStatus, fields, employeeId) {
    const existing = await this.advanceRequestRepo.getById(id);
    if (!existing) throw notFound("Advance request not found");

    if (!ACTS_ON[stage].includes(existing.status)) {
      throw conflict(describeStatus(existing.status));
    }

    // The update matches on the status just read, not on a fixed one: a stage
    // that accepts several starting statuses must still only write over the
    // exact row state this caller saw.
    const result = await this.advanceRequestRepo.updateStage(
      id,
      existing.status,
      nextStatus,
      fields
    );

    // No rows matched: someone else moved it between the read and the write.
    if (result.affectedRows === 0) {
      const current = await this.advanceRequestRepo.getById(id);
      throw conflict(describeStatus(current ? current.status : "gone"));
    }

    await this.advanceRequestRepo.createActivity(
      id,
      employeeId,
      "status",
      existing.status,
      nextStatus
    );

    return this.getById(id);
  }

  /**
   * A1.1 - accounts record what the supplier already holds.
   *
   * The figure decides where the request goes, not the person entering it:
   * anything outstanding has to go back to purchase to be settled one way
   * or the other, and nothing outstanding has nothing to settle.
   */
  balanceCheck(id, data, employeeId) {
    const balance = Number(data.previous_advance_balance) || 0;

    return this.applyStage(
      id,
      "balanceCheck",
      balance > 0 ? "pending_purchase_decision" : "pending_approval",
      {
        previous_advance_balance: data.previous_advance_balance,
        balance_remarks: data.balance_remarks ?? null,
        balance_checked_by: employeeId ?? null,
        balance_checked_at: new Date(),
      },
      employeeId
    );
  }

  /**
   * A1.2 - purchase decide what to do about the balance accounts found:
   * less-and-pay deducts it from this payment, defer leaves it to be
   * clarified with the supplier later. Only the decision is recorded -
   * accounts work the payable figure out in Tally.
   */
  balanceAction(id, data, employeeId) {
    return this.applyStage(
      id,
      "balanceAction",
      "pending_approval",
      {
        balance_action: data.balance_action,
        balance_action_note: data.balance_action_note ?? null,
        balance_action_by: employeeId ?? null,
        balance_action_at: new Date(),
      },
      employeeId
    );
  }

  /**
   * A2 - the admin approves, holds, or rejects. Rejection is terminal; a
   * hold waits for the admin to come back to it.
   *
   * Releasing a hold may carry a balance action, because re-clarifying and
   * deciding what to do about the old balance is the whole reason a request
   * gets held - so the admin decides and approves in one step rather than
   * sending it back round.
   */
  async approval(id, data, employeeId) {
    const nextStatus = DECISION_STATUS[data.decision];
    if (!nextStatus) {
      throw conflict(`Unknown decision: ${data.decision}`);
    }

    const fields = {
      approval_note: data.approval_note ?? null,
      approved_by: employeeId ?? null,
      approved_at: new Date(),
    };

    if (data.balance_action) {
      fields.balance_action = data.balance_action;
      fields.balance_action_note = data.balance_action_note ?? null;
      fields.balance_action_by = employeeId ?? null;
      fields.balance_action_at = new Date();
    }

    return this.applyStage(id, "approval", nextStatus, fields, employeeId);
  }

  /**
   * A3 - file the payment advice, which closes the request.
   *
   * The payment itself is made in Tally, so its figures live there. This step
   * records only that accounts paid and when; the advice document is attached
   * separately through addDocument.
   */
  payment(id, data, employeeId) {
    return this.applyStage(
      id,
      "payment",
      "paid",
      {
        paid_by: employeeId ?? null,
        paid_at: new Date(),
      },
      employeeId
    );
  }

  /**
   * Corrects the A1 fields.
   *
   * Allowed while the request is still with purchase or accounts, and while
   * the admin is holding it, since correcting the figures is often what a
   * hold is waiting for. An edit never moves the request: releasing a hold
   * is the admin's decision, and an earlier version of this promoted a held
   * request straight to the approver, which let a raiser change the amount
   * and reach the admin with the balance figures already stale.
   *
   * A request anyone downstream has acted on is not editable: changing the
   * amount under an approval already given would be a new request.
   */
  async updateDetails(id, data, employeeId) {
    const existing = await this.advanceRequestRepo.getById(id);
    if (!existing) throw notFound("Advance request not found");

    if (!ACTS_ON.edit.includes(existing.status)) {
      throw conflict(
        `This request can no longer be edited. ${describeStatus(
          existing.status
        )}`
      );
    }

    const fields = {};
    ["invoice_number", "distributor_code", "amount", "reason"].forEach(
      (key) => {
        if (data[key] !== undefined) fields[key] = data[key];
      }
    );

    if (Object.keys(fields).length === 0) return this.getById(id);

    // An edit corrects the request; it does not move it. The status goes
    // back unchanged so the compare-and-set still guards the write.
    const result = await this.advanceRequestRepo.updateStage(
      id,
      existing.status,
      existing.status,
      fields
    );

    if (result.affectedRows === 0) {
      const current = await this.advanceRequestRepo.getById(id);
      throw conflict(describeStatus(current ? current.status : "gone"));
    }

    // Record only what actually changed, so the log reads as a history
    // rather than a list of everything the form happened to post back.
    await Promise.all(
      Object.keys(fields)
        .filter((key) => String(existing[key]) !== String(fields[key]))
        .map((key) =>
          this.advanceRequestRepo.createActivity(
            id,
            employeeId,
            key,
            existing[key],
            fields[key]
          )
        )
    );

    return this.getById(id);
  }

  /**
   * Attaches an already-uploaded file. The upload itself goes through
   * POST /asset, which returns the S3 URL stored here.
   */
  async addDocument(id, stage, fileUrl, employeeId) {
    const existing = await this.advanceRequestRepo.getById(id);
    if (!existing) throw notFound("Advance request not found");

    // A1 docs support a request that is still moving; a payment proof only
    // means anything once the payment has been authorised.
    if (stage === "a1" && TERMINAL.includes(existing.status)) {
      throw conflict(describeStatus(existing.status));
    }

    if (stage === "a3" && !["approved", "paid"].includes(existing.status)) {
      throw conflict(
        `A payment proof can only be attached once the request is approved. ${describeStatus(
          existing.status
        )}`
      );
    }

    await this.advanceRequestRepo.createDocument(
      id,
      stage,
      fileUrl,
      employeeId
    );

    return this.advanceRequestRepo.getDocumentsByRequestId(id);
  }
}

module.exports = (advanceRequestRepo) => {
  return new AdvanceRequestUsecase(advanceRequestRepo);
};
