/**
 * The advance request approval chain.
 *
 * A request moves A1 (raised) -> A1.1 (balance checked) -> A2 (approved)
 * -> A3 (paid). Each stage may only act on the status the stage before it
 * left behind, so the rules live here rather than in the routes: the route
 * says who may call a stage, this says whether the request is in a state
 * where that stage means anything.
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
  balanceCheck: ["submitted", "on_hold"],
  approval: ["verified"],
  payment: ["approved"],
  edit: ["submitted", "on_hold"],
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

  /** A1.1 - accounts records what the supplier already owes and holds. */
  balanceCheck(id, data, employeeId) {
    // An on-hold request has been checked but is not cleared to go to
    // approval; it stays out of the approver's queue until re-checked.
    const nextStatus = data.on_hold ? "on_hold" : "verified";

    return this.applyStage(
      id,
      "balanceCheck",
      nextStatus,
      {
        pending_bills: data.pending_bills,
        previous_advance_balance: data.previous_advance_balance,
        balance_remarks: data.balance_remarks ?? null,
        balance_checked_by: employeeId ?? null,
        balance_checked_at: new Date(),
      },
      employeeId
    );
  }

  /** A2 - approve or reject. Rejection is terminal. */
  approval(id, data, employeeId) {
    const approved = Number(data.approval_status) === 1;

    return this.applyStage(
      id,
      "approval",
      approved ? "approved" : "rejected",
      {
        approval_status: approved ? 1 : 0,
        approval_note: data.approval_note ?? null,
        approved_by: employeeId ?? null,
        approved_at: new Date(),
      },
      employeeId
    );
  }

  /**
   * A3 - record the payment.
   *
   * paid_amount is stored separately from amount: an advance is sometimes
   * settled for less than was approved, and overwriting the approved figure
   * would lose what was actually authorised.
   */
  payment(id, data, employeeId) {
    return this.applyStage(
      id,
      "payment",
      "paid",
      {
        paid_amount: data.paid_amount,
        utr: data.utr,
        bank_id: data.bank_id,
        payment_date: data.payment_date,
        paid_by: employeeId ?? null,
        paid_at: new Date(),
      },
      employeeId
    );
  }

  /**
   * Corrects the A1 fields.
   *
   * Allowed while the request is still submitted, and while it is on hold -
   * clarifying a held request is the whole point of the hold. Editing a held
   * request clears the hold and sends it straight to the approver, so a
   * clarification does not sit waiting for a second balance check. A request
   * anyone downstream has acted on is not editable: changing the amount under
   * an approval already given would be a new request, not an edit.
   */
  async updateDetails(id, data, employeeId) {
    const existing = await this.advanceRequestRepo.getById(id);
    if (!existing) throw notFound("Advance request not found");

    if (!ACTS_ON.edit.includes(existing.status)) {
      throw conflict(
        `Only a submitted or on-hold request can be edited. ${describeStatus(
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

    // Editing releases a hold; a submitted request keeps the status it has.
    const nextStatus =
      existing.status === "on_hold" ? "verified" : existing.status;

    const result = await this.advanceRequestRepo.updateStage(
      id,
      existing.status,
      nextStatus,
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

    // The release is a transition in its own right, so the history says why a
    // held request became approvable rather than only what text changed.
    if (nextStatus !== existing.status) {
      await this.advanceRequestRepo.createActivity(
        id,
        employeeId,
        "status",
        existing.status,
        nextStatus
      );
    }

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
